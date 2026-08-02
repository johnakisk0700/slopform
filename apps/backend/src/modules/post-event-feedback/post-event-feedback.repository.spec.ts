import { describe, expect, it, vi } from "vitest";

import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  feedbackAnswers,
  feedbackAnswerWithdrawals,
  messageOutbox,
  providerMessageIngress,
} from "@join-the-six/database";

import type { DatabaseService } from "../../infrastructure/database/database.service.js";
import { FeedbackResultsRepository } from "./extraction/results.repository.js";
import { FeedbackIngressRepository } from "./ingress/ingress.repository.js";
import { FeedbackOutboxRepository } from "./outbox/outbox.repository.js";
import { FeedbackCampaignRepository } from "./campaign/campaign.repository.js";

function createInsertChain(returningValue: unknown[]) {
  const returning = vi.fn().mockResolvedValue(returningValue);
  const onConflictDoNothing = vi.fn().mockReturnValue({ returning });
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi
    .fn()
    .mockReturnValue({ onConflictDoNothing, onConflictDoUpdate });
  const insert = vi.fn().mockReturnValue({ values });

  return {
    insert,
    values,
    onConflictDoNothing,
    onConflictDoUpdate,
    returning,
  };
}

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

describe("feedback repository conflict targets", () => {
  it("dedupes ingress inserts on (chat_jid, provider_message_id)", async () => {
    const chain = createInsertChain([
      {
        id: "11111111-1111-4111-8111-111111111111",
        providerMessageId: "wamid.1",
        chatJid: "306900000001@s.whatsapp.net",
      },
    ]);
    const execute = vi.fn().mockResolvedValue(undefined);
    const transaction = { execute, insert: chain.insert };
    const repository = new FeedbackIngressRepository({
      db: {},
    } as DatabaseService);

    const result = await repository.insertIngressIfAbsent(
      transaction as never,
      {
        providerMessageId: "wamid.1",
        chatJid: "306900000001@s.whatsapp.net",
        direction: "inbound",
        phoneE164: "+306900000001",
        observedAt: new Date("2026-07-25T18:00:00.000Z"),
        text: "γεια",
      },
    );

    const [lockStatement] = execute.mock.calls[0] as [SQL];
    expect(new PgDialect().sqlToQuery(lockStatement).sql).toBe(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
    );
    expect(new PgDialect().sqlToQuery(lockStatement).params).toEqual([
      "feedback-ingress-phone:+306900000001",
    ]);
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      chain.insert.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(chain.onConflictDoNothing).toHaveBeenCalledWith({
      target: [
        providerMessageIngress.chatJid,
        providerMessageIngress.providerMessageId,
      ],
    });
    expect(result.inserted).toBe(true);
  });

  it("orders outbound observations under the same phone lock", async () => {
    const chain = createInsertChain([{ id: "outbound-ingress" }]);
    const execute = vi.fn().mockResolvedValue(undefined);
    const repository = new FeedbackIngressRepository({
      db: {},
    } as DatabaseService);

    await repository.insertIngressIfAbsent(
      { execute, insert: chain.insert } as never,
      {
        providerMessageId: "wamid.outbound",
        chatJid: "306900000001@s.whatsapp.net",
        direction: "outbound",
        phoneE164: "+306900000001",
        observedAt: new Date("2026-07-25T18:00:00.000Z"),
        text: "θα σε πάρει κάποιος",
      },
    );

    const [lockStatement] = execute.mock.calls[0] as [SQL];
    expect(new PgDialect().sqlToQuery(lockStatement).params).toEqual([
      "feedback-ingress-phone:+306900000001",
    ]);
    expect(execute.mock.invocationCallOrder[0]).toBeLessThan(
      chain.insert.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
  });

  it("orders observations without a phone under their chat routing lock", async () => {
    const chain = createInsertChain([{ id: "unmatched-ingress" }]);
    const execute = vi.fn().mockResolvedValue(undefined);
    const repository = new FeedbackIngressRepository({
      db: {},
    } as DatabaseService);

    await repository.insertIngressIfAbsent(
      { execute, insert: chain.insert } as never,
      {
        providerMessageId: "wamid.unmatched",
        chatJid: "shared-session@g.us",
        direction: "inbound",
        phoneE164: null,
        observedAt: new Date("2026-07-25T18:00:00.000Z"),
        text: "ποιος είναι;",
      },
    );

    const [lockStatement] = execute.mock.calls[0] as [SQL];
    expect(new PgDialect().sqlToQuery(lockStatement).params).toEqual([
      "feedback-ingress-chat:shared-session@g.us",
    ]);
  });

  it("finds pending or newly materialized inbound beyond an extraction snapshot", async () => {
    const limit = vi.fn().mockResolvedValue([{ id: "new-ingress" }]);
    const where = vi.fn().mockReturnValue({ limit });
    const from = vi.fn().mockReturnValue({ where });
    const select = vi.fn().mockReturnValue({ from });
    const repository = new FeedbackIngressRepository({
      db: {},
    } as DatabaseService);

    const found = await repository.hasInboundBeyondSnapshot(
      { select } as never,
      {
        phoneE164: "+306900000001",
        conversationId: "33333333-3333-4333-8333-333333333333",
        snapshotIngressIds: ["11111111-1111-4111-8111-111111111111"],
      },
    );

    expect(found).toBe(true);
    const [predicate] = where.mock.calls[0] as [SQL];
    const query = new PgDialect().sqlToQuery(predicate);
    expect(query.sql).toContain('"direction" = $1');
    expect(query.sql).toContain('"processing_status" = $3');
    expect(query.sql).toContain('"processing_status" = $4');
    expect(query.sql).toContain('"matched_conversation_id" = $5');
    expect(query.sql).toContain('"id" not in ($6)');
    expect(query.params).toEqual([
      "inbound",
      "+306900000001",
      "pending",
      "materialized",
      "33333333-3333-4333-8333-333333333333",
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("dedupes outbox inserts on dedupe_key", async () => {
    const chain = createInsertChain([
      {
        id: "22222222-2222-4222-8222-222222222222",
        dedupeKey: "conversation:1:cursor:3",
      },
    ]);
    const transaction = { insert: chain.insert };
    const database = { db: {} } as DatabaseService;
    const repository = new FeedbackOutboxRepository(
      database,
      new FeedbackCampaignRepository(database),
    );

    const result = await repository.insertOutboxIfAbsent(transaction as never, {
      conversationId: "33333333-3333-4333-8333-333333333333",
      campaignId: "44444444-4444-4444-8444-444444444444",
      kind: "reply",
      body: "Ευχαριστούμε!",
      dedupeKey: "conversation:1:cursor:3",
    });

    expect(chain.onConflictDoNothing).toHaveBeenCalledWith({
      target: [messageOutbox.dedupeKey],
    });
    expect(result.inserted).toBe(true);
  });

  it("overwrites an answer on the NULLS NOT DISTINCT uniqueness key so a revision lands", async () => {
    const chain = createInsertChain([]);
    const withdrawals = createWithdrawalSelectChain([]);
    const transaction = { insert: chain.insert, select: withdrawals.select };
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
      extractionMeta: {
        model: "google/gemini-3.6-flash",
        confidence: 0.9,
        candidateIds: ["99999999-9999-4999-8999-999999999999"],
      },
    });

    // The newest reading of a question wins, on the same uniqueness key: the
    // participant revising an answer is the case this exists for.
    const [config] = chain.onConflictDoUpdate.mock.calls[0] as [
      {
        target: unknown[];
        setWhere: SQL;
        set: {
          valueInt: number | null;
          extractionMeta: SQL;
          matchingHold: SQL;
        };
      },
    ];
    expect(config.target).toStrictEqual([
      feedbackAnswers.conversationId,
      feedbackAnswers.questionKey,
      feedbackAnswers.subjectParticipantId,
    ]);
    expect(config.set.valueInt).toBe(5);
    expect(result).toBeUndefined();

    // Two guards on that overwrite, both of them SQL rather than application
    // logic, so a run that read its context before a correction landed cannot
    // win the race.
    const dialect = new PgDialect();
    // A corrected row is frozen: the conflicting insert updates nothing.
    expect(dialect.sqlToQuery(config.setWhere).sql).toBe(
      `not ("feedback_answers"."extraction_meta" ? 'corrections')`,
    );
    // And an ordinary revision carries the corrections array across instead of
    // replacing the whole blob, so the row keeps saying a human touched it.
    expect(dialect.sqlToQuery(config.set.extractionMeta).sql).toBe(
      "excluded.extraction_meta || case when \"feedback_answers\".\"extraction_meta\" ? 'corrections' then jsonb_build_object('corrections', \"feedback_answers\".\"extraction_meta\" -> 'corrections') else '{}'::jsonb end",
    );
    // A hold only ever accumulates. The run that found the respondent abusing
    // the person this answer is about has already happened; a later burst
    // restating the answer in polite words does not make it honourable, and an
    // `excluded`-wins update would quietly lift the hold.
    expect(dialect.sqlToQuery(config.set.matchingHold).sql).toBe(
      '"feedback_answers"."matching_hold" or excluded.matching_hold',
    );
  });

  it("refuses to record an answer on a slot an operator withdrew", async () => {
    const chain = createInsertChain([]);
    const withdrawals = createWithdrawalSelectChain([
      {
        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        answerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        withdrawnBy: "admin-1",
      },
    ]);
    const transaction = { insert: chain.insert, select: withdrawals.select };
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
    expect(withdrawals.from).toHaveBeenCalledWith(feedbackAnswerWithdrawals);
    expect(chain.insert).not.toHaveBeenCalled();
    expect(result).toBeUndefined();

    // `NULLS NOT DISTINCT`, spelled out: a subjectless question has one slot per
    // conversation, and `subject_participant_id = null` would match nothing.
    const [slot] = withdrawals.where.mock.calls[0] as [SQL];
    expect(new PgDialect().sqlToQuery(slot).sql).toContain(
      '"subject_participant_id" is null',
    );
  });

  it("will not clear a contradicted answer an operator corrected", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const where = vi.fn().mockReturnValue({ returning });
    const deleteFrom = vi.fn().mockReturnValue({ where });
    const repository = new FeedbackResultsRepository({
      db: {},
    } as DatabaseService);

    await repository.deleteContradictedAnswers(
      { delete: deleteFrom } as never,
      {
        conversationId: "66666666-6666-4666-8666-666666666666",
        subjectParticipantId: "77777777-7777-4777-8777-777777777777",
        questionKeys: ["liked", "meet_again"],
      },
    );

    // This is the module's one model-driven hard delete of an answer: accepting
    // `avoid` for somebody clears `liked` and `meet_again` about them. Without
    // the guard, a later run would erase an operator's corrected row outright —
    // freezing has to mean the model may stop agreeing with a human, not that
    // it may delete them.
    const [condition] = where.mock.calls[0] as [SQL];
    expect(new PgDialect().sqlToQuery(condition).sql).toContain(
      `not ("feedback_answers"."extraction_meta" ? 'corrections')`,
    );
  });
});
