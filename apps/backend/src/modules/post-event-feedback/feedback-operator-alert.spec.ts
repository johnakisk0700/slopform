import { Logger } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { Environment } from "../../infrastructure/config/environment.js";
import { LoggingFeedbackOperatorAlert } from "./feedback-operator-alert.js";

describe("LoggingFeedbackOperatorAlert", () => {
  beforeAll(() => {
    Logger.overrideLogger(false);
  });

  it("emits one structured warning an operator's log search can alert on", async () => {
    const alert = createAlert("log");
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await alert.raise({
      conversationId: "conversation-1",
      campaignId: "campaign-1",
      reason: "safety_keywords",
      correlationId: "correlation-1",
      detail: ["sexual_content"],
    });

    expect(warn).toHaveBeenCalledWith({
      event: "feedback.operator_alert",
      correlationId: "correlation-1",
      conversationId: "conversation-1",
      campaignId: "campaign-1",
      reason: "safety_keywords",
      detail: ["sexual_content"],
    });
    warn.mockRestore();
  });

  it("omits an empty detail rather than logging an empty array", async () => {
    const alert = createAlert("log");
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await alert.raise({
      conversationId: "conversation-1",
      campaignId: "campaign-1",
      reason: "extraction_failed",
      correlationId: "correlation-1",
      detail: [],
    });

    expect(warn.mock.calls[0]?.[0]).not.toHaveProperty("detail");
    warn.mockRestore();
  });

  it("stays silent when the seam is switched off", async () => {
    const alert = createAlert("off");
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => undefined);

    await alert.raise({
      conversationId: "conversation-1",
      campaignId: "campaign-1",
      reason: "extraction_failed",
      correlationId: "correlation-1",
    });

    // `needsAttention` is still recorded durably by the caller; only the
    // notification channel is disabled.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

function createAlert(mode: "log" | "off"): LoggingFeedbackOperatorAlert {
  return new LoggingFeedbackOperatorAlert({
    get: () => mode,
  } as unknown as ConfigService<Environment, true>);
}
