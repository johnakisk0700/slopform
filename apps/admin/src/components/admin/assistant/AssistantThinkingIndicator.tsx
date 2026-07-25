import { PenLine } from "lucide-react";
import { useEffect, useState } from "react";

const ROTATE_MS = 2_400;
const PHRASES = [
  "Reviewing the context",
  "Working through the details",
  "Preparing the response",
  "Checking the reasoning",
] as const;

/** Quiet compositor-only activity marker copied from notes_ai's chat. */
export function AssistantThinkingIndicator() {
  const [index, setIndex] = useState(() =>
    Math.floor(Math.random() * PHRASES.length),
  );

  useEffect(() => {
    const id = window.setInterval(() => {
      setIndex((previous) => {
        const next = Math.floor(Math.random() * (PHRASES.length - 1));
        return next >= previous ? next + 1 : next;
      });
    }, ROTATE_MS);

    return () => window.clearInterval(id);
  }, []);

  return (
    <span
      className="mt-3 flex w-fit items-center gap-1.5 text-xs text-ink-muted"
      role="status"
      aria-label="Assistant is working"
    >
      <PenLine aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="assistant-thinking" aria-hidden="true">
        {PHRASES[index]}…
      </span>
    </span>
  );
}
