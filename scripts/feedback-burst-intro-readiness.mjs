/**
 * Resolve intro readiness from the current conversation's durable outbox row.
 * Phone-only sink checks are unsafe because burst personas reuse reserved
 * numbers across rehearsals; an old accepted intro must not launder a failed
 * current one.
 */
export function assessFeedbackBurstIntroReadiness({
  targets,
  introRows,
  sinkRows,
}) {
  const rowsByConversation = new Map();
  for (const row of introRows) {
    const rows = rowsByConversation.get(row.conversationId) ?? [];
    rows.push(row);
    rowsByConversation.set(row.conversationId, rows);
  }
  const acceptedOutboxIds = new Set(sinkRows.map((row) => row.outboxId));
  const pending = [];
  const terminal = [];

  for (const target of targets) {
    const rows = rowsByConversation.get(target.conversationId) ?? [];
    if (rows.length === 0) {
      pending.push({ ...target, reason: "intro_outbox_missing" });
      continue;
    }
    if (rows.length > 1) {
      terminal.push({ ...target, reason: "multiple_intro_outboxes" });
      continue;
    }

    const [row] = rows;
    if (["failed", "cancelled", "ambiguous"].includes(row.status)) {
      terminal.push({
        ...target,
        outboxId: row.id,
        reason: `intro_${row.status}`,
      });
      continue;
    }
    if (row.status !== "sent") {
      pending.push({
        ...target,
        outboxId: row.id,
        reason: `intro_${row.status}`,
      });
      continue;
    }
    if (!acceptedOutboxIds.has(row.id)) {
      pending.push({
        ...target,
        outboxId: row.id,
        reason: "intro_sink_missing",
      });
    }
  }

  return {
    ready: pending.length === 0 && terminal.length === 0,
    pending,
    terminal,
  };
}
