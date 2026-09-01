import type { ReactNode } from "react";
import { CalendarDays, MessagesSquare, ShieldCheck, Users } from "lucide-react";

import { BrandLockup } from "./BrandLockup";
import { BrandMark } from "./BrandMark";

/** What the workspace behind this screen actually holds — the three live areas. */
const WORKSPACE_AREAS = [
  {
    icon: CalendarDays,
    title: "Events and bookings",
    detail: "Seats, blockers and the run-up to every dinner.",
  },
  {
    icon: Users,
    title: "Participant profiles",
    detail: "Who is coming, and what they have already told us.",
  },
  {
    icon: MessagesSquare,
    title: "Post-event feedback",
    detail: "Conversations, results and the outbound queue.",
  },
] as const;

/**
 * The sign-in frame. `children` is the form slot: the Clerk widget once its
 * script has loaded, and `SignInFormPlaceholder` until then.
 *
 * The frame is deliberately outside the router, because it is also what the app
 * paints while Clerk is still loading. One screen owns the whole sign-in wait:
 * the panel, the heading and the card are identical in both states, so nothing
 * re-lays-out around the form when the widget arrives.
 */
export function SignInLayout({ children }: { children: ReactNode }) {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="grid min-h-screen bg-canvas lg:grid-cols-[minmax(0,0.95fr)_minmax(30rem,1fr)]"
    >
      <section className="relative hidden overflow-hidden border-r border-sidebar-border bg-sidebar p-12 text-sidebar-fg lg:flex lg:flex-col lg:justify-between">
        {/* The oversized form/chat outline gives the unauthenticated slab one
            quiet brand shape without competing with the sign-in card. It uses
            the same surface-owned currentColor contract as the small mark and
            remains decorative. */}
        <BrandMark className="pointer-events-none absolute top-1/2 right-0 size-[34rem] -translate-y-1/2 -rotate-90 text-sidebar-active-index opacity-[0.06]" />

        <div className="relative">
          <BrandLockup
            surface="strong"
            tagline="Admin workspace"
            taglineClassName="text-sidebar-fg-muted"
          />
        </div>
        <div className="relative max-w-lg">
          <p className="jts-overline text-sidebar-fg-muted">
            Private operations
          </p>
          {/* Was «One secure entrance to the admin workspace.» — a sentence
              that described the door rather than the room. Whoever is reading
              it already knows they are at a sign-in; what they cannot see is
              what the workspace is for. */}
          <p className="mt-4 font-display text-4xl font-extrabold leading-tight tracking-tight">
            The form is texting you now.
          </p>
          <ul className="mt-9 grid gap-6">
            {WORKSPACE_AREAS.map(({ icon: Icon, title, detail }) => (
              <li key={title} className="flex gap-4">
                <Icon
                  aria-hidden="true"
                  className="mt-0.5 size-5 shrink-0 text-sidebar-fg-muted"
                />
                <span className="grid gap-1">
                  <span className="text-sm font-bold">{title}</span>
                  <span className="text-sm leading-6 text-sidebar-fg-muted">
                    {detail}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative flex items-center gap-2 text-xs font-semibold text-sidebar-fg-muted">
          <ShieldCheck aria-hidden="true" className="size-4" />
          Authorized staff only
        </p>
      </section>

      <section
        aria-label="Admin authentication"
        className="grid place-items-center p-6 sm:p-10"
      >
        <div className="w-full max-w-md">
          {/* The logo is the visible title. The screen-reader suffix names the
              route, and Clerk's own card heading stays hidden so the page owns
              one stable h1 from first paint. */}
          <h1 className="flex flex-col items-center gap-3 text-center">
            <BrandMark className="size-16 text-primary" />
            <span className="font-brand text-2xl font-extrabold tracking-tight text-ink">
              Slopform
            </span>
            <span className="sr-only"> — admin sign in</span>
          </h1>
          {/* Was «Sign-in proves identity. The backend separately checks that
              your profile is approved for this admin.» — the architecture,
              narrated to somebody who only wants to get in. It named a backend
              they cannot see and left out the one thing they can act on: which
              account to use, and why the right person can still be refused. */}
          <p className="mt-4 text-center text-sm leading-6 text-ink-muted">
            Use the Google account your access was granted on. Being the right
            person is not enough — access is checked separately.
          </p>
          {/* No padding here: the form pads itself and the «Secured by Clerk»
              band pads itself, so the band reaches the card's own edges. */}
          <div className="mt-6 overflow-hidden rounded-md border border-border bg-surface shadow-sm">
            {children}
          </div>
        </div>
      </section>
    </main>
  );
}

/**
 * The form slot while Clerk's script is in flight: the shape of the form, not a
 * sentence about authentication. It breathes rather than sitting dead, and the
 * reduced-motion rule stills it (see `.jts-pending`).
 */
export function SignInFormPlaceholder() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading the secure sign-in form</span>
      {/* The same p-8 and the same bottom band the loaded widget carries, so
          the card keeps its size when Clerk swaps the form in. */}
      <div aria-hidden="true" className="grid gap-6 p-8">
        <span className="jts-pending h-8 w-full" />
        <span className="jts-pending h-px w-full" />
        <span className="grid gap-2">
          <span className="jts-pending h-3 w-28" />
          <span className="jts-pending h-8 w-full" />
        </span>
        <span className="jts-pending h-8 w-full" />
      </div>
      <div
        aria-hidden="true"
        className="grid justify-items-center border-t border-border bg-surface-sunken p-4"
      >
        <span className="jts-pending h-3 w-32" />
      </div>
    </div>
  );
}
