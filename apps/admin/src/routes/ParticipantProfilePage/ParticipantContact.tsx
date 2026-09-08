import { Button } from "@heroui/react";
import { AtSign, Check, Copy, Phone } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * The contact pill, and the page's one rule about colour.
 *
 * **The sheet spends one hue, and it is `primary`** — the links, the pill
 * hovers and five of the six title dots. Every glyph that only labels a field
 * is neutral ink. Two earlier cuts each got half of this: the first painted
 * the email and phone *values* in the accent, the second moved that accent
 * onto the leading glyphs and spread it to all seven icons on the card. Both
 * left copper and primary sharing one screen with nothing to tell them apart
 * — near-neighbours in the warm palettes, so the eye read the pair as an
 * accident rather than as two meanings. Copper stays what tokens.css says it
 * is: occasional emphasis (the Overview aside, the sixth title dot), never a
 * page's icon ink.
 *
 * The leading glyph is what earlier drafts were missing rather than the
 * colour: every other labelled field here is icon-led, so a bare pill had
 * nothing to belong to. `AtSign` / `Phone` are the same icons — now in the
 * same `ink-subtle` — the feedback pane's Respondent header spends on these
 * two fields.
 *
 * The fill is `surface-sunken` over `border`, the recipe VenuePill and
 * CopyableId share, so the pill sits in the card instead of floating over it.
 */
const contactPillClassName =
  "inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-sunken px-2 py-0.5 text-sm text-ink transition-colors hover:border-primary";

export function ContactEmail({ email }: { email: string }) {
  const { copied, copyValue } = useCopyFeedback();

  return (
    <span title={email} className="inline-flex max-w-full">
      <Button
        variant="ghost"
        onPress={() => void copyValue(email)}
        aria-label={copied ? "Copied email" : "Copy email"}
        className={`${contactPillClassName} h-auto min-h-0 cursor-pointer font-normal hover:bg-surface-sunken hover:text-primary data-[hovered=true]:bg-surface-sunken`}
      >
        <AtSign
          aria-hidden="true"
          className="size-3.5 shrink-0 text-ink-subtle"
        />
        <span className="truncate">{email}</span>
        {copied ? (
          <Check
            aria-hidden="true"
            className="size-3.5 shrink-0 text-primary"
          />
        ) : (
          <Copy
            aria-hidden="true"
            className="size-3.5 shrink-0 text-ink-subtle"
          />
        )}
      </Button>
    </span>
  );
}

/**
 * The number dials via `tel:` (mobile), and a quiet copy control sits beside it
 * for desktop paste jobs — two affordances in one pill, so the hover states
 * stay on the parts rather than on the whole.
 */
export function ContactPhone({ phone }: { phone: string }) {
  const { copied, copyValue } = useCopyFeedback();

  return (
    <span className={contactPillClassName}>
      <Phone aria-hidden="true" className="size-3.5 shrink-0 text-ink-subtle" />
      <a
        href={`tel:${phone}`}
        className="truncate tabular-nums underline-offset-2 transition-colors hover:text-primary hover:underline"
      >
        {phone}
      </a>
      <span title={phone} className="inline-flex shrink-0">
        <Button
          isIconOnly
          variant="ghost"
          size="sm"
          onPress={() => void copyValue(phone)}
          aria-label={copied ? "Copied phone" : "Copy phone"}
          className="size-6 min-h-6 min-w-6 shrink-0 text-ink-subtle hover:bg-transparent hover:text-primary data-[hovered=true]:bg-transparent"
        >
          {copied ? (
            <Check aria-hidden="true" className="size-3.5 text-primary" />
          ) : (
            <Copy aria-hidden="true" className="size-3.5" />
          )}
        </Button>
      </span>
    </span>
  );
}

/** Long enough to notice, short enough not to linger — same beat as CopyableId. */
const COPIED_FEEDBACK_MS = 1_500;

function useCopyFeedback() {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  async function copyValue(value: string): Promise<void> {
    clearTimeout(resetTimerRef.current);
    try {
      await navigator.clipboard?.writeText(value);
      setCopied(true);
      resetTimerRef.current = setTimeout(
        () => setCopied(false),
        COPIED_FEEDBACK_MS,
      );
    } catch {
      // Clipboard can be unavailable on insecure LAN origins; leave the UI calm.
    }
  }

  return { copied, copyValue };
}
