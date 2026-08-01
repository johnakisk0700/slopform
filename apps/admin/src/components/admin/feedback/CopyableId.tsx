import { clsx } from "clsx";
import { Check, Copy } from "lucide-react";
import { useEffect, useRef, useState } from "react";

/**
 * How much of an id is worth showing. Eight characters is where a uuid stops
 * being a wall and starts being recognisable — enough to tell two rows apart,
 * short enough that a stack of ids still reads as a column of facts.
 */
const ID_VISIBLE_CHARS = 8;
/** Below this, the ellipsis costs more than it saves. */
const ID_SHORTEN_ABOVE = 12;
/** Long enough to notice, short enough not to linger as a state. */
const COPIED_FEEDBACK_MS = 1_500;

function shortenId(value: string): string {
  return value.length > ID_SHORTEN_ABOVE
    ? `${value.slice(0, ID_VISIBLE_CHARS)}…`
    : value;
}

interface CopyableIdProps {
  value: string;
  /**
   * What the id is, spoken: «Copy correlation id». Lower case, because the
   * button's label is built around it.
   */
  label: string;
  className?: string;
}

/**
 * An id an operator can read, verify in full, and take with them.
 *
 * Every id in the delivery pane exists to be pasted somewhere else — a
 * correlation id into the backend logs, an ingress id into the conversation, a
 * provider message id into the provider's own console. Printing it in full ate
 * the row and still left it to be selected by hand, so it is truncated, the
 * whole value is on `title` for a hover, and one click puts it on the
 * clipboard.
 *
 * The confirmation is a glyph swap for a second and a half and nothing else:
 * same box, same width, so a row never moves under the pointer. A clipboard
 * that refuses (an insecure LAN origin) leaves the button exactly as it was
 * rather than claiming a copy that did not happen.
 */
export function CopyableId({ value, label, className }: CopyableIdProps) {
  const [copied, setCopied] = useState(false);
  const resetTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(resetTimerRef.current), []);

  async function copyValue(): Promise<void> {
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

  return (
    <button
      type="button"
      title={value}
      aria-label={copied ? `Copied ${label}` : `Copy ${label}`}
      onClick={() => void copyValue()}
      className={clsx(
        "inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm border border-border-subtle bg-surface-sunken px-1.5 py-px font-mono text-xs text-ink transition-colors hover:border-border hover:text-primary",
        className,
      )}
    >
      <span className="truncate">{shortenId(value)}</span>
      {copied ? (
        <Check aria-hidden="true" className="size-3 shrink-0 text-primary" />
      ) : (
        <Copy aria-hidden="true" className="size-3 shrink-0 text-ink-subtle" />
      )}
    </button>
  );
}
