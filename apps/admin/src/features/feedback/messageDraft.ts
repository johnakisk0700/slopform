interface MessageDraft {
  readonly text: string;
  readonly clientMessageId: string;
}

type ClientMessageIdFactory = () => string;

const randomClientMessageId: ClientMessageIdFactory = () =>
  globalThis.crypto.randomUUID();

/** One idempotency identity belongs to one exact composer draft. */
export function createMessageDraft(
  createId: ClientMessageIdFactory = randomClientMessageId,
): MessageDraft {
  return { text: "", clientMessageId: createId() };
}

/** Any edit creates a new intent; an unchanged retry keeps the old identity. */
export function editMessageDraft(
  current: MessageDraft,
  text: string,
  createId: ClientMessageIdFactory = randomClientMessageId,
): MessageDraft {
  if (text === current.text) {
    return current;
  }
  return { text, clientMessageId: createId() };
}

/**
 * A failed/unknown request preserves both text and id for a safe retry. A
 * success clears only the submitted draft: a newer edit must never disappear
 * when an older request settles.
 */
export function settleMessageDraft(
  current: MessageDraft,
  submittedClientMessageId: string,
  succeeded: boolean,
  createId: ClientMessageIdFactory = randomClientMessageId,
): MessageDraft {
  if (!succeeded || current.clientMessageId !== submittedClientMessageId) {
    return current;
  }
  return createMessageDraft(createId);
}
