/**
 * Queue names whose jobs are part of one feedback burst conversation path.
 *
 * Keep the list in one place: the runner inspects terminal failures and the
 * reset clears terminal residue. If those two lists drift, the next rehearsal
 * can either hide the failure that just happened or inherit it from the prior
 * run.
 */
export function resolveFeedbackBurstQueueNames(queueConstants) {
  const names = [
    queueConstants?.FEEDBACK_QUEUE,
    queueConstants?.FEEDBACK_INGRESS_QUEUE,
    queueConstants?.FEEDBACK_CONVERSATION_QUEUE,
  ];

  if (names.some((name) => typeof name !== "string" || name.length === 0)) {
    throw new Error(
      "Built backend is missing a feedback burst queue constant; rebuild apps/backend/dist",
    );
  }
  if (new Set(names).size !== names.length) {
    throw new Error("Feedback burst queue constants must name distinct queues");
  }

  return names;
}
