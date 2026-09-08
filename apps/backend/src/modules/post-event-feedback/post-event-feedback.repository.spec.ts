import { describe, expect, it, vi } from "vitest";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import { FeedbackResultsRepository } from "./extraction/results.repository.js";

/**
 * The tombstone lookup every answer write now makes. `rows` is what the slot
 * holds: empty for a slot no operator has emptied.
 */
function createWithdrawalSelectChain(rows: unknown[]) {
  const limit = vi.fn().mockResolvedValue(rows);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });

  return { select, from, where, limit };
}

describe("feedback answer withdrawal", () => {
  it("refuses to record an answer on a slot an operator withdrew", async () => {
    const insert = vi.fn();
    const withdrawals = createWithdrawalSelectChain([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        answerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        withdrawnBy: "admin-1",
      },
    ]);
    const transaction = { insert, select: withdrawals.select };
    const repository = new FeedbackResultsRepository({
      db: {},
    } as DatabaseService);

    const result = await repository.insertAnswerIfAbsent(transaction as never, {
      campaignId: "55555555-5555-4555-8555-555555555555",
      conversationId: "66666666-6666-4666-8666-666666666666",
      respondentParticipantId: "77777777-7777-4777-8777-777777777777",
      subjectParticipantId: null,
      questionKey: "event_score",
      valueInt: 5,
      sourceMessageIds: ["88888888-8888-4888-8888-888888888888"],
      extractionMeta: { candidateIds: [] },
    });

    // The withdrawal freeze, and the one guard that cannot be a predicate on the
    // row: the row an operator withdrew was deleted for good, so the tombstone on
    // the slot is what is left to consult. Without this, a later run reading the
    // participant's words writes the answer straight back and the operator is
    // never told their decision was undone.
    expect(insert).not.toHaveBeenCalled();
    expect(result).toBeUndefined();
  });
});
