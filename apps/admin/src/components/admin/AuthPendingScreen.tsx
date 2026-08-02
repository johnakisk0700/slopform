import { BrandLockup } from "./BrandLockup";

/**
 * The wait before a private route can be decided: Clerk's script loading, or
 * the backend allowlist answering. It is deliberately almost empty — the wait
 * is short and uneventful, so it gets the brand and a breathing rule rather
 * than a titled card explaining that authentication is happening.
 *
 * The sign-in route does not use it: `SignInLayout` paints the screen the URL
 * already promises.
 */
export function AuthPendingScreen() {
  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="grid min-h-screen place-items-center bg-canvas p-6"
    >
      <div
        role="status"
        aria-busy="true"
        className="grid justify-items-center gap-7"
      >
        <BrandLockup surface="default" wordmarkClassName="text-xl text-ink" />
        <span aria-hidden="true" className="jts-pending h-1 w-36" />
        <span className="sr-only">Checking admin access</span>
      </div>
    </main>
  );
}
