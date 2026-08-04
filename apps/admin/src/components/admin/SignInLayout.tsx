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
        {/* The mark at the size it was drawn to be read at. It is five people
            and an empty chair around a table — the one image this product has
            that means something — and at 40px in a corner none of that is
            visible.

            Whole, not bled off a corner. Cropping was the first attempt and it
            was wrong for this particular mark: the composition is radial, so a
            corner of it is six circles and no table, which reads as blobs
            rather than as the thing the company is named after. If it is on the
            page at all it has to be the whole figure.

            Quarter-turn anticlockwise, centred on the panel's vertical axis and
            set so the figure's base lands exactly on the divider — the mark
            stands on the seam between the two halves of the screen instead of
            floating in the middle of one of them. The turn is what makes that
            possible: upright, the base is the bottom edge and would have to sit
            on the footer.

            The «no glows, gradient washes, blurred circles» rule in the cookbook
            governs the operator screens, where every mark on the canvas has to
            be a status somebody can act on. This is the unauthenticated shell:
            nobody is triaging here, there is no data to compete with, and the
            only thing on screen worth looking at before the form is the brand.
            5% of the sidebar's own foreground, so it is a change in the surface
            rather than an object on it — and it is `aria-hidden`, like every
            other instance of the mark. */}
        <BrandMark className="pointer-events-none absolute top-1/2 right-0 size-[34rem] -translate-y-1/2 -rotate-90 text-sidebar-fg opacity-[0.03]" />

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
            Six seats, one table, and everything it takes to fill them.
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
          {/* The logo is the title.

              This column used to open with an overline, an `h1` reading «Sign
              in» wearing the six-dot mark, and a two-line paragraph — three
              blocks of type before the one button anyone came here to press,
              on a page whose entire content is that button. And the word it
              spent the `h1` on is the word already printed on the button
              underneath.

              So the heading is the brand: the mark at a size where the five
              people and the empty chair are legible, over the wordmark. On a
              product's own front door the product's name is the honest title,
              and it makes the logo the largest thing on the page instead of
              the smallest.

              The six-dot mark went with the old heading, and not only because
              the heading did. Those dots are five in the primary and a sixth
              in the accent — the table with the seat still open, which is the
              logo's own idea in abstract. Directly above the literal mark it
              was the same sentence twice.

              The page still owns its `h1`, which is why Clerk's card header
              stays hidden: one title on screen from the first paint, not one
              that arrives late above another. The screen-reader half names the
              page rather than the company, because «Join The Six» alone would
              not tell somebody navigating by heading which of this product's
              screens they had landed on. */}
          <h1 className="flex flex-col items-center gap-3 text-center">
            <BrandMark className="size-16 text-primary" />
            <span className="font-brand text-2xl font-extrabold tracking-tight text-ink">
              Join The Six
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
