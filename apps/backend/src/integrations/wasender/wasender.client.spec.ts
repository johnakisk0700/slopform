import { describe, expect, it, vi } from "vitest";

import { WasenderClient, WasenderClientError } from "./wasender.client.js";

const messageKey = {
  id: "provider-message-id",
  fromMe: true,
  remoteJid: "306900000000@s.whatsapp.net",
};

describe("WasenderClient", () => {
  it("sends a bounded text request with the session bearer key", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          msgId: 100_000,
          jid: "+306900000000",
          status: "in_progress",
        },
      }),
    );
    const client = createClient(fetchMock);

    await expect(
      client.sendText({ to: "+306900000000", text: "Questionnaire link" }),
    ).resolves.toEqual({
      providerLogId: 100_000,
      recipient: "+306900000000",
      providerStatus: "in_progress",
    });

    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url?.toString()).toBe("https://wasender.test/api/send-message");
    expect(request).toMatchObject({
      method: "POST",
      headers: {
        authorization: "Bearer test-session-key",
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        to: "+306900000000",
        text: "Questionnaire link",
      }),
    });
    expect(request?.signal).toBeInstanceOf(AbortSignal);
  });

  it("normalizes message info and marks the exact webhook key as read", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          success: true,
          data: {
            remoteJid: messageKey.remoteJid,
            id: messageKey.id,
            msgId: 100_000,
            key: messageKey,
            message: { conversation: "content is deliberately not returned" },
            messageTimestamp: "1751297488",
            status: 4,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ success: true, data: { status: "read" } }),
      );
    const client = createClient(fetchMock);

    await expect(client.getMessageInfo(100_000)).resolves.toEqual({
      providerLogId: 100_000,
      providerMessageId: messageKey.id,
      remoteJid: messageKey.remoteJid,
      messageKey,
      occurredAt: "2025-06-30T15:31:28.000Z",
      status: "read",
      providerStatusCode: 4,
    });
    await expect(client.markMessageAsRead(messageKey)).resolves.toBeUndefined();

    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({ key: messageKey }),
    });
  });

  it("classifies HTTP failures without copying provider content into errors", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse(
        {
          success: false,
          message: "credential and participant content must stay private",
        },
        429,
        {
          "retry-after": "7",
          "x-ratelimit-reset": "999",
        },
      ),
    );
    const client = createClient(fetchMock);

    const error = await client
      .sendText({ to: "+306900000000", text: "Hello" })
      .catch((reason: unknown) => reason);

    expect(error).toBeInstanceOf(WasenderClientError);
    expect(error).toMatchObject({
      kind: "http",
      operation: "send-text",
      deliveryOutcome: "not-accepted",
      statusCode: 429,
      retryAfterSeconds: 7,
    });
    expect(String(error)).not.toContain("credential");
    expect(String(error)).not.toContain("participant");
  });

  it("normalizes either documented reset-header interpretation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T00:00:00.000Z"));

    try {
      const nowSeconds = Math.floor(Date.now() / 1_000);
      const resetValues = ["9", String(nowSeconds + 11)];

      for (const [index, reset] of resetValues.entries()) {
        const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
          jsonResponse({ message: "rate limited" }, 429, {
            "x-ratelimit-reset": reset,
          }),
        );
        const error = await createClient(fetchMock)
          .sendText({ to: "+306900000000", text: "Hello" })
          .catch((reason: unknown) => reason);

        expect(error).toMatchObject({
          retryAfterSeconds: index === 0 ? 9 : 11,
        });
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the documented numeric retry_after body when headers are absent", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse({ message: "rate limited", retry_after: 5 }, 429),
      );

    const error = await createClient(fetchMock)
      .sendText({ to: "+306900000000", text: "Hello" })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({ retryAfterSeconds: 5 });
  });

  it("treats send timeouts, 5xx responses and malformed success as ambiguous", async () => {
    const failures = [
      vi
        .fn<typeof fetch>()
        .mockRejectedValue(
          new DOMException("provider payload", "TimeoutError"),
        ),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ message: "provider payload" }, 503)),
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(jsonResponse({ success: true, data: {} })),
    ];

    for (const fetchMock of failures) {
      const error = await createClient(fetchMock)
        .sendText({ to: "+306900000000", text: "Hello" })
        .catch((reason: unknown) => reason);

      expect(error).toBeInstanceOf(WasenderClientError);
      expect(error).toMatchObject({
        operation: "send-text",
        deliveryOutcome: "unknown",
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(error)).not.toContain("provider payload");
    }
  });

  it("rejects non-E.164 recipients before making a request", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const client = createClient(fetchMock);

    await expect(
      client.sendText({ to: "0690000000", text: "Hello" }),
    ).rejects.toThrow(/E\.164/);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function createClient(fetchImplementation: typeof fetch): WasenderClient {
  return new WasenderClient({
    apiKey: "test-session-key",
    baseUrl: "https://wasender.test",
    fetch: fetchImplementation,
  });
}

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
