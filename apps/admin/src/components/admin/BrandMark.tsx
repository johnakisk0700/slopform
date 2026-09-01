import { clsx } from "clsx";

interface BrandMarkProps {
  className?: string;
}

/**
 * Slopform mark: a form inside the conversation bubble it has become.
 * Strokes use `currentColor`, so callers own the tone for their surface.
 */
export function BrandMark({ className }: BrandMarkProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={clsx("shrink-0", className ?? "h-9 w-9")}
    >
      <path
        strokeWidth={2.4}
        d="M7.5 4.5h17A2.5 2.5 0 0 1 27 7v13a2.5 2.5 0 0 1-2.5 2.5H18l-6 5v-5H7.5A2.5 2.5 0 0 1 5 20V7a2.5 2.5 0 0 1 2.5-2.5Z"
      />
      <path strokeWidth={2.2} d="m9.5 10.5 1.5 1.5 2.75-3" />
      <path strokeWidth={2.2} d="M17 10.5h5M9.5 16.5H22" />
    </svg>
  );
}
