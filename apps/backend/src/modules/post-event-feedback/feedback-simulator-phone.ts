/**
 * Maps an E.164 counterparty to the personal-chat JID shape Wasender webhooks
 * use, so the dev injector produces the same `ObservedProviderMessage` contract
 * as the real adapter.
 */
export function feedbackPhoneE164ToChatJid(phoneE164: string): string {
  const digits = phoneE164.startsWith("+") ? phoneE164.slice(1) : phoneE164;
  return `${digits}@s.whatsapp.net`;
}
