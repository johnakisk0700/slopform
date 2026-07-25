import { z } from "zod";

import {
  type WasenderMessageKey,
  type WasenderMessageStatusCode,
  type WhatsAppDeliveryStatus,
  wasenderMessageKeySchema,
  wasenderMessageStatusCodeSchema,
  whatsAppE164Schema,
} from "./wasender.schemas.js";

const DEFAULT_BASE_URL = "https://www.wasenderapi.com";
const DEFAULT_TIMEOUT_MS = 8_000;

const clientOptionsSchema = z
  .object({
    apiKey: z
      .string()
      .min(1)
      .max(512)
      .refine(
        (value) => value === value.trim() && !/[\r\n]/u.test(value),
        "Invalid Wasender session API key",
      ),
    requestTimeoutMs: z.number().int().min(250).max(30_000),
  })
  .strict();

const sendTextInputSchema = z
  .object({
    to: whatsAppE164Schema,
    text: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => value.trim().length > 0, "Message must not be blank"),
  })
  .strict();

const sendTextResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        msgId: z.number().int().positive(),
        jid: z.string().trim().min(1).max(512),
        status: z.string().trim().min(1).max(64),
      })
      .loose(),
  })
  .loose();

const providerMessageTimestampSchema = z
  .union([z.string().regex(/^\d+$/u), z.number().int().positive()])
  .refine((value) => {
    const numericValue = Number(value);
    const milliseconds =
      numericValue < 1_000_000_000_000 ? numericValue * 1_000 : numericValue;
    return (
      Number.isFinite(numericValue) &&
      !Number.isNaN(new Date(milliseconds).valueOf())
    );
  }, "Invalid provider message timestamp");

const messageInfoResponseSchema = z
  .object({
    success: z.literal(true),
    data: z
      .object({
        remoteJid: z.string().trim().min(1).max(512),
        id: z.string().trim().min(1).max(512),
        msgId: z.number().int().positive(),
        key: wasenderMessageKeySchema,
        messageTimestamp: providerMessageTimestampSchema,
        status: wasenderMessageStatusCodeSchema,
      })
      .loose(),
  })
  .loose();

const markReadResponseSchema = z
  .object({
    success: z.literal(true),
    data: z.object({ status: z.literal("read") }).loose(),
  })
  .loose();

const providerRateLimitErrorSchema = z
  .object({ retry_after: z.number().int().nonnegative() })
  .loose();

const STATUS_BY_CODE: Record<
  WasenderMessageStatusCode,
  WhatsAppDeliveryStatus
> = {
  0: "error",
  1: "pending",
  2: "sent",
  3: "delivered",
  4: "read",
  5: "played",
};

export type WasenderClientErrorKind =
  "http" | "network" | "timeout" | "malformed-response";

export class WasenderClientError extends Error {
  override readonly name = "WasenderClientError";

  constructor(
    message: string,
    readonly kind: WasenderClientErrorKind,
    readonly operation: "send-text" | "get-message-info" | "mark-read",
    readonly deliveryOutcome: "not-applicable" | "not-accepted" | "unknown",
    readonly statusCode?: number,
    readonly retryAfterSeconds?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type WasenderClientOptions = {
  readonly apiKey: string;
  readonly requestTimeoutMs?: number;
  /** Code-owned override for tests; never populate this from request data. */
  readonly baseUrl?: string;
  readonly fetch?: typeof fetch;
};

export type WasenderSendTextInput = z.input<typeof sendTextInputSchema>;

export type WasenderSendTextResult = {
  readonly providerLogId: number;
  readonly recipient: string;
  readonly providerStatus: string;
};

export type WasenderMessageInfo = {
  readonly providerLogId: number;
  readonly providerMessageId: string;
  readonly remoteJid: string;
  readonly messageKey: WasenderMessageKey;
  readonly occurredAt: string;
  readonly status: WhatsAppDeliveryStatus;
  readonly providerStatusCode: WasenderMessageStatusCode;
};

/**
 * Narrow Wasender session client. It deliberately has no automatic retries:
 * retrying an ambiguous send can create duplicate WhatsApp messages.
 */
export class WasenderClient {
  private readonly apiKey: string;
  private readonly baseUrl: URL;
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: WasenderClientOptions) {
    const parsed = clientOptionsSchema.parse({
      apiKey: options.apiKey,
      requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    this.apiKey = parsed.apiKey;
    this.requestTimeoutMs = parsed.requestTimeoutMs;
    this.baseUrl = new URL(options.baseUrl ?? DEFAULT_BASE_URL);
    this.fetchImplementation = options.fetch ?? globalThis.fetch;
  }

  async sendText(
    input: WasenderSendTextInput,
  ): Promise<WasenderSendTextResult> {
    const body = sendTextInputSchema.parse(input);
    const response = await this.request(
      "send-text",
      "/api/send-message",
      sendTextResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(body),
      },
    );

    return {
      providerLogId: response.data.msgId,
      recipient: response.data.jid,
      providerStatus: response.data.status,
    };
  }

  async getMessageInfo(providerLogId: number): Promise<WasenderMessageInfo> {
    const messageId = z.number().int().positive().parse(providerLogId);
    const response = await this.request(
      "get-message-info",
      `/api/messages/${messageId}/info`,
      messageInfoResponseSchema,
      { method: "GET" },
    );
    const providerTimestamp = Number(response.data.messageTimestamp);
    const milliseconds =
      providerTimestamp < 1_000_000_000_000
        ? providerTimestamp * 1_000
        : providerTimestamp;

    return {
      providerLogId: response.data.msgId,
      providerMessageId: response.data.id,
      remoteJid: response.data.remoteJid,
      messageKey: response.data.key,
      occurredAt: new Date(milliseconds).toISOString(),
      status: STATUS_BY_CODE[response.data.status],
      providerStatusCode: response.data.status,
    };
  }

  async markMessageAsRead(messageKey: WasenderMessageKey): Promise<void> {
    const key = wasenderMessageKeySchema.parse(messageKey);
    await this.request(
      "mark-read",
      "/api/messages/read",
      markReadResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ key }),
      },
    );
  }

  private async request<T>(
    operation: WasenderClientError["operation"],
    path: string,
    responseSchema: z.ZodType<T>,
    init: Pick<RequestInit, "body" | "method">,
  ): Promise<T> {
    let response: Response;

    try {
      response = await this.fetchImplementation(new URL(path, this.baseUrl), {
        ...init,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: "application/json",
          ...(init.body ? { "content-type": "application/json" } : {}),
        },
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (error) {
      const timedOut = isTimeoutError(error);
      throw new WasenderClientError(
        timedOut
          ? "Wasender API request timed out"
          : "Wasender API request failed before a response was received",
        timedOut ? "timeout" : "network",
        operation,
        operation === "send-text" ? "unknown" : "not-applicable",
        undefined,
        undefined,
        { cause: safeCause(error) },
      );
    }

    const body = await readJson(response);
    if (!response.ok) {
      const retryAfterSeconds = parseRetryAfter(response.headers, body);
      const deliveryOutcome =
        operation !== "send-text"
          ? "not-applicable"
          : response.status >= 500
            ? "unknown"
            : "not-accepted";

      throw new WasenderClientError(
        `Wasender API request failed with HTTP ${response.status}`,
        "http",
        operation,
        deliveryOutcome,
        response.status,
        retryAfterSeconds,
      );
    }

    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) {
      throw new WasenderClientError(
        "Wasender API returned an unexpected response",
        "malformed-response",
        operation,
        operation === "send-text" ? "unknown" : "not-applicable",
        response.status,
      );
    }

    return parsed.data;
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function parseRetryAfter(headers: Headers, body: unknown): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    if (/^\d+$/u.test(retryAfter)) {
      const seconds = Number(retryAfter);
      return Number.isSafeInteger(seconds) ? seconds : undefined;
    }

    const retryAt = Date.parse(retryAfter);
    return Number.isNaN(retryAt)
      ? undefined
      : Math.max(0, Math.ceil((retryAt - Date.now()) / 1_000));
  }

  const providerError = providerRateLimitErrorSchema.safeParse(body);
  if (providerError.success) {
    return providerError.data.retry_after;
  }

  const rateLimitReset = headers.get("x-ratelimit-reset");

  if (!rateLimitReset || !/^\d+$/u.test(rateLimitReset)) {
    return undefined;
  }

  const value = Number(rateLimitReset);
  if (!Number.isSafeInteger(value)) {
    return undefined;
  }

  // The official table describes a delta in seconds, while some provider
  // examples treat reset headers as Unix time. Support both without guessing
  // from response content.
  const nowSeconds = Math.floor(Date.now() / 1_000);
  return value > nowSeconds - 60 ? Math.max(0, value - nowSeconds) : value;
}

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

function safeCause(error: unknown): Error | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }

  return new Error(error.name);
}
