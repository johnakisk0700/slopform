import { afterEach, describe, expect, it, vi } from "vitest";

import { ResendClient, ResendClientError } from "./resend.client.js";

const input = {
  recipientEmail: "person@example.com",
  subject: "Notice",
  textBody: "Body",
  idempotencyKey: "7c57f3b8-2b13-48f5-8730-18ac71f490cd",
} as const;

describe("ResendClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the minimal authenticated request with the delivery key", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ id: "resend-message-id" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      new ResendClient({
        apiKey: "re_test-key",
        fromEmail: "sender@example.com",
      }).sendEmail(input),
    ).resolves.toBeUndefined();

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://api.resend.com/emails");
    expect(request).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: {
        authorization: "Bearer re_test-key",
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey,
        "user-agent": "slopform-email/1.0",
      },
      body: JSON.stringify({
        from: "sender@example.com",
        to: [input.recipientEmail],
        subject: input.subject,
        text: input.textBody,
      }),
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("keeps permanent provider failures safe and non-retryable", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          name: "validation_error",
          message: "private recipient and credential details",
        },
        403,
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await new ResendClient({
      apiKey: "re_test-key",
      fromEmail: "sender@example.com",
    })
      .sendEmail(input)
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(ResendClientError);
    expect(error).toMatchObject({
      retryable: false,
    });
    expect(String(error)).not.toContain("private");
  });

  it("preserves a bounded retry-after hint for retryable responses", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({ name: "rate_limit_exceeded" }, 429, {
        "retry-after": "7",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const error = await new ResendClient({
      apiKey: "re_test-key",
      fromEmail: "sender@example.com",
    })
      .sendEmail(input)
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      retryable: true,
      retryAfterSeconds: 7,
    });
  });

  it("retries concurrent idempotent requests but fails an invalid key reuse", async () => {
    const concurrentFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ name: "concurrent_idempotent_requests" }, 409),
      );
    vi.stubGlobal("fetch", concurrentFetch);

    const client = new ResendClient({
      apiKey: "re_test-key",
      fromEmail: "sender@example.com",
    });
    const concurrentError = await client
      .sendEmail(input)
      .catch((reason: unknown) => reason);
    expect(concurrentError).toMatchObject({ retryable: true });

    const invalidFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ name: "invalid_idempotency_key" }, 409),
      );
    vi.stubGlobal("fetch", invalidFetch);
    const invalidError = await client
      .sendEmail(input)
      .catch((reason: unknown) => reason);
    expect(invalidError).toMatchObject({ retryable: false });
  });

  it("treats provider call failures and malformed success as retryable", async () => {
    const failures = [
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(new Error("private provider response")),
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new DOMException("request timed out", "TimeoutError"),
        ),
      vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, 503)),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ message: "no id" })),
    ];
    const client = new ResendClient({
      apiKey: "re_test-key",
      fromEmail: "sender@example.com",
    });

    for (const fetchMock of failures) {
      vi.stubGlobal("fetch", fetchMock);
      const error = await client
        .sendEmail(input)
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(ResendClientError);
      expect(error).toMatchObject({ retryable: true });
      expect(String(error)).not.toContain("private");
    }
  });
});

function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
