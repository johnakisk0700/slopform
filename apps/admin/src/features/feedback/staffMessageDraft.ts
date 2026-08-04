export interface StaffMessageDraft {
  readonly text: string;
  readonly clientMessageId: string;
}

type ClientMessageIdFactory = () => string;

const randomClientMessageId: ClientMessageIdFactory = () =>
  globalThis.crypto.randomUUID();

/** One idempotency identity belongs to one exact composer draft. */
export function createStaffMessageDraft(
  createId: ClientMessageIdFactory = randomClientMessageId,
): StaffMessageDraft {
  return { text: "", clientMessageId: createId() };
}

/** Any edit creates a new intent; an unchanged retry keeps the old identity. */
export function editStaffMessageDraft(
  current: StaffMessageDraft,
  text: string,
  createId: ClientMessageIdFactory = randomClientMessageId,
): StaffMessageDraft {
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
export function settleStaffMessageDraft(
  current: StaffMessageDraft,
  submittedClientMessageId: string,
  succeeded: boolean,
  createId: ClientMessageIdFactory = randomClientMessageId,
): StaffMessageDraft {
  if (!succeeded || current.clientMessageId !== submittedClientMessageId) {
    return current;
  }
  return createStaffMessageDraft(createId);
}

/**
 * The development simulator has the same retry contract as the staff composer:
 * one exact draft keeps one stable idempotency identity until success.
 */
export const createSimulatorMessageDraft = createStaffMessageDraft;
export const editSimulatorMessageDraft = editStaffMessageDraft;
export const settleSimulatorMessageDraft = settleStaffMessageDraft;
