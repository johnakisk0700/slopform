/**
 * Maps an E.164 counterparty to the personal-chat JID shape Wasender webhooks
 * use, so the dev injector produces the same `ObservedProviderMessage` contract
 * as the real adapter.
 */
export function phoneE164ToChatJid(phoneE164: string): string {
  const digits = phoneE164.startsWith("+") ? phoneE164.slice(1) : phoneE164;
  return `${digits}@s.whatsapp.net`;
}

export function normalizePhone(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const localPart = value.split("@", 1)[0]?.replace(/^\+/u, "");
  return localPart && /^[1-9]\d{7,14}$/u.test(localPart)
    ? `+${localPart}`
    : undefined;
}
