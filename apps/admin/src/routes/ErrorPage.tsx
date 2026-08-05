import { buttonVariants } from "@heroui/react";
import { Link } from "react-router";

import { BrandLockup } from "../components/admin/BrandLockup";
import { usePageMeta } from "../lib/usePageMeta";

/**
 * Standalone 404 screen for unknown routes.
 *
 * Wired as the router catch-all (`<Route path="*" element=… />`) under
 * `BrowserRouter`. There is no data router in this SPA, so there is no thrown
 * route error to read — every path that reaches here is simply an address that
 * does not exist.
 */
export function ErrorPage() {
  usePageMeta("Page not found", "The requested admin page could not be found.");

  return (
    <div className="min-h-screen bg-canvas">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <header className="mx-auto w-full max-w-content px-4 py-6">
        <BrandLockup
          to="/admin"
          surface="default"
          className="text-ink hover:text-primary"
        />
      </header>

      <main
        id="main-content"
        tabIndex={-1}
        className="relative mx-auto w-full max-w-3xl px-4 py-[clamp(4rem,14vw,10rem)]"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute top-0 right-0 z-0 font-display text-[clamp(9rem,30vw,18rem)] leading-none font-extrabold tracking-tighter text-surface-sunken tabular-nums"
        >
          404
        </div>

        <div className="relative z-10">
          <p className="mb-3 text-xs font-extrabold uppercase tracking-caps text-primary">
            Unknown route
          </p>
          <h1 className="mb-4 max-w-[14ch] font-display text-[length:var(--jts-text-2xl)] font-extrabold tracking-tighter">
            This admin page does not exist.
          </h1>
          <p className="mb-8 max-w-[50ch] text-[length:var(--jts-text-lg)] text-ink-muted">
            The address may have changed, or the link may be incomplete.
          </p>
          <Link
            to="/admin"
            className={`${buttonVariants({ variant: "primary" })} no-underline`}
          >
            Return to control center
          </Link>
        </div>
      </main>
    </div>
  );
}
