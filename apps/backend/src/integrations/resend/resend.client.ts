const REQUEST_TIMEOUT_MS = 10_000;

export type EmailDeliverySendInput = {
  readonly recipientEmail: string;
  readonly subject: string;
  readonly textBody: string;
  readonly idempotencyKey: string;
};

export type ResendClientOptions = {
  readonly apiKey: string;
  readonly fromEmail: string;
};

export class ResendClientError extends Error {
  override readonly name = ResendClientError.name;

  constructor(
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
  ) {
    super("Email provider request failed");
  }
}

/** Minimal Resend HTTP adapter for the email worker. */
export class ResendClient {
  private readonly apiKey: string;
  private readonly fromEmail: string;

  constructor(options: ResendClientOptions) {
    this.apiKey = options.apiKey;
    this.fromEmail = options.fromEmail;
  }

  async sendEmail(input: EmailDeliverySendInput): Promise<void> {
    let response: Response;

    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
          "idempotency-key": input.idempotencyKey,
          "user-agent": "slopform-email/1.0",
        },
        body: JSON.stringify({
          from: this.fromEmail,
          to: [input.recipientEmail],
          subject: input.subject,
          text: input.textBody,
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ResendClientError(true);
    }

    const body = await readJson(response);
    if (!response.ok) {
      throw new ResendClientError(
        isRetryableResponse(response.status, body),
        parseRetryAfter(response.headers),
      );
    }

    if (!isResendSuccess(body)) {
      throw new ResendClientError(true);
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function isResendSuccess(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const id = (value as { readonly id?: unknown }).id;
  return typeof id === "string" && id.trim().length > 0;
}

function isRetryableResponse(statusCode: number, body: unknown): boolean {
  if (statusCode === 409) {
    return (
      typeof body === "object" &&
      body !== null &&
      (body as { readonly name?: unknown }).name ===
        "concurrent_idempotent_requests"
    );
  }

  return statusCode === 408 || statusCode === 429 || statusCode >= 500;
}

function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get("retry-after");
  if (!value || !/^\d+$/u.test(value)) return undefined;

  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : undefined;
}
