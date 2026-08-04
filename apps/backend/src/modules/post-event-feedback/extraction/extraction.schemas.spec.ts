import { describe, expect, it } from "vitest";

import {
  createFeedbackClosingDedupeKey,
  isFeedbackClosingDedupeKey,
} from "./extraction.schemas.js";

describe("feedback closing dedupe identity", () => {
  const conversationId = "11111111-1111-4111-8111-111111111111";

  it("is stable within one work revision and changes after resume", () => {
    const first = createFeedbackClosingDedupeKey(conversationId, 12, 7);

    expect(first).toBe(`feedback-closing-${conversationId}-12-r7`);
    expect(createFeedbackClosingDedupeKey(conversationId, 12, 7)).toBe(first);
    expect(createFeedbackClosingDedupeKey(conversationId, 12, 8)).not.toBe(
      first,
    );
    expect(isFeedbackClosingDedupeKey(conversationId, first)).toBe(true);
  });

  it("recognizes retained V1/V2 keys without accepting malformed generations", () => {
    expect(
      isFeedbackClosingDedupeKey(
        conversationId,
        `feedback-closing-${conversationId}`,
      ),
    ).toBe(true);
    expect(
      isFeedbackClosingDedupeKey(
        conversationId,
        `feedback-closing-${conversationId}-12`,
      ),
    ).toBe(true);
    expect(
      isFeedbackClosingDedupeKey(
        conversationId,
        `feedback-closing-${conversationId}-12-r`,
      ),
    ).toBe(false);
    expect(
      isFeedbackClosingDedupeKey(
        conversationId,
        `feedback-closing-${conversationId}-12-r7-extra`,
      ),
    ).toBe(false);
    expect(
      isFeedbackClosingDedupeKey(
        conversationId,
        `feedback-closing-${conversationId}-0-r7`,
      ),
    ).toBe(false);
  });
});
