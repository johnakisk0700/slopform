import { useState } from "react";
import { Button, Drawer } from "@heroui/react";
import { clsx } from "clsx";
import { Menu, Unlock } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Outlet, useLocation } from "react-router";

import { env } from "../../lib/env";
import { AdminNavigation } from "./AdminNavigation";
import { AdminUserMenu } from "./AdminUserMenu";
import { BrandLockup } from "./BrandLockup";

/**
 * The two facts about this deployment that are not a given: which environment
 * the operator is looking at, and — when it is on — that the local
 * authentication bypass is answering for them.
 *
 * They share one chip shape and one row. Stacked as plain lines they read as
 * text appended under the brand; as matching chips they read as one status
 * strip, and the bypass is a peer of the environment rather than a louder
 * afterthought. The shell's only environment indicator, so it renders in both
 * places the brand lockup does (wine sidebar, light drawer) with the tones of
 * each surface.
 */
function EnvironmentChips({ variant }: { variant: "sidebar" | "drawer" }) {
  // Full-strength foreground rather than a warning tone for the bypass: both
  // verified pairs (text on wine, text on surface) clear AA, and
  // warning-on-surface is not one of the measured pairings.
  const chip = clsx(
    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 jts-overline",
    variant === "sidebar"
      ? "border-sidebar-border bg-sidebar-hover text-sidebar-fg"
      : "border-border bg-surface-sunken text-ink",
  );

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className={chip}>
        <span className="status-dot" aria-hidden="true" />
        Local
      </span>
      {env.authDevBypass ? (
        <span className={chip}>
          <Unlock aria-hidden="true" className="size-3" />
          Auth bypass
        </span>
      ) : null}
    </div>
  );
}

/**
 * Routes that take the viewport rather than grow a scrollbar.
 *
 * The default is the right default: a page is as tall as its content and the
 * document scrolls. These two are the exceptions because they are *panes*, not
 * documents — a conversation and a log beside the row it opened — and a pane
 * that pushes the page taller than the screen makes the operator scroll the
 * whole layout to reach a control that was meant to be permanently in view.
 * Anything added here must own its own inner scrolling.
 */
const FULL_HEIGHT_ROUTES = ["/admin/assistant", "/admin/outbound"] as const;

/**
 * Of those, the ones that also paint to the shell's edge.
 *
 * The assistant is a single surface and its own padding is part of it. The
 * outbound queue is an ordinary page that happens to be full height, so it
 * keeps the standard page gutter every other screen has.
 */
const BLEED_ROUTES = ["/admin/assistant"] as const;

/** The docked assistant owns the remaining viewport on narrow screens too. */
const MOBILE_VIEWPORT_ROUTES = ["/admin/assistant"] as const;

/**
 * Route families whose children own navigation without leaving the screen.
 *
 * A durable assistant thread changes the URL, but it is still the same chat
 * surface. Keying the shell entrance by the full thread URL unmounted the
 * entire assistant on create/select, replayed the opacity/translate entrance
 * and discarded its scroll and optimistic-transition refs. Keep one shell key
 * for the whole family; entering from another admin screen still animates.
 */
const STABLE_MOUNT_ROUTES = ["/admin/assistant"] as const;

function matchesRoute(pathname: string, routes: readonly string[]): boolean {
  return routes.some(
    (route) => pathname === route || pathname.startsWith(`${route}/`),
  );
}

function routeTransitionKey(pathname: string): string {
  return (
    STABLE_MOUNT_ROUTES.find(
      (route) => pathname === route || pathname.startsWith(`${route}/`),
    ) ?? pathname
  );
}

/**
 * The routed main region: the content column with the signature 200ms
 * opacity/8px-rise entrance. It re-runs when the route surface changes and
 * collapses to no motion when the viewer prefers reduced motion. Navigation
 * inside the assistant keeps one mount because its URL is conversation state,
 * not a different screen.
 */
function AdminMain() {
  const reduceMotion = useReducedMotion();
  const { pathname } = useLocation();
  const isFullHeight = matchesRoute(pathname, FULL_HEIGHT_ROUTES);
  const bleeds = matchesRoute(pathname, BLEED_ROUTES);
  const ownsMobileViewport = matchesRoute(pathname, MOBILE_VIEWPORT_ROUTES);
  const transitionKey = routeTransitionKey(pathname);

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={clsx(
        "w-full",
        // `lg:h-dvh`, and deliberately **not** `flex-1`.
        //
        // Every ancestor up to `<body>` is sized by `min-height`, so there is
        // no definite height anywhere for `flex-1` to resolve against — and
        // `flex: 1 1 0%` sets a `flex-basis` that wins over `height` on the
        // main axis, so it also silently swallowed any height stated here.
        // Between them, a route that asked for the viewport got the document
        // instead. This is the first element in the chain that can name a
        // height, so it names one and takes no flex sizing at all.
        //
        // The assistant gets a definite remaining height from the shell on
        // narrow screens, so flex-1 is correct there and lets the mobile top
        // bar keep its own height. Outbound remains an ordinary narrow-screen
        // document and names the viewport only once its two-pane layout starts.
        isFullHeight
          ? clsx(
              "relative overflow-hidden focus-visible:-outline-offset-2 lg:h-dvh",
              ownsMobileViewport ? "min-h-0 flex-1 lg:flex-none" : undefined,
            )
          : undefined,
        bleeds
          ? undefined
          : "mx-auto max-w-content p-[clamp(1.25rem,3vw,2.5rem)]",
      )}
    >
      <motion.div
        key={transitionKey}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={isFullHeight ? "h-full min-h-0" : undefined}
      >
        <Outlet />
      </motion.div>
    </main>
  );
}

/**
 * The admin application shell.
 *
 * Desktop (>=64rem): a two-column grid over the warm canvas with a sticky,
 * full-height wine sidebar (the brand lockup with its "Admin workspace"
 * tagline, {@link EnvironmentChips}, navigation, operator menu) and no top bar.
 * Small screens hide the sidebar and surface a top bar whose hamburger opens
 * the same navigation in a left drawer. The environment chips, operator menu
 * and navigation render in both places.
 *
 * Nothing is stacked above this element: the shell is the whole viewport, so
 * every route's own scrolling starts from a full height rather than from the
 * height a banner left behind.
 */
export function AdminShell() {
  const [isNavOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  const ownsMobileViewport = matchesRoute(pathname, MOBILE_VIEWPORT_ROUTES);

  return (
    <div
      className={clsx(
        "flex min-h-0 flex-1 flex-col bg-canvas lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]",
        // `flex-1` has a zero basis and would outrank h-dvh on #root's main
        // axis. The viewport pane names its height, so it must not also ask the
        // parent to calculate that height from free space.
        ownsMobileViewport ? "h-dvh flex-none overflow-hidden" : undefined,
      )}
    >
      {/* pb-4 matches the operator row's own pt-4, so that row sits centred
          between its rule and the panel edge instead of riding 8px high. */}
      <aside className="hidden border-r border-sidebar-border bg-sidebar px-4 pt-6 pb-4 text-sidebar-fg lg:sticky lg:top-0 lg:flex lg:h-full lg:max-h-dvh lg:flex-col">
        <BrandLockup
          to="/admin"
          surface="strong"
          className="px-3 text-sidebar-fg"
          tagline="Admin workspace"
          taglineClassName="text-sidebar-fg-muted"
        />
        <div className="mt-4 mb-5 border-b border-sidebar-border px-3 pb-5">
          <EnvironmentChips variant="sidebar" />
        </div>

        <AdminNavigation variant="sidebar" />

        <div className="mt-4 border-t border-sidebar-border pt-4">
          {/* Hover and open states come from the sidebar's own translucent
              white, not the page palette: HeroUI's ghost button paints its
              pressed state with the light-mode soft fill, which on this
              inverse surface put warm beige under near-white text and the
              operator's own name became unreadable the moment they opened
              the menu. */}
          <AdminUserMenu className="w-full text-sidebar-fg hover:bg-sidebar-hover data-[pressed]:bg-sidebar-active" />
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex min-h-[4.5rem] shrink-0 items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 lg:hidden">
          <div className="flex items-center gap-3">
            {/* The Drawer's DialogTrigger wires aria-expanded / aria-controls /
                aria-haspopup and the press handler onto the hamburger. */}
            <Drawer isOpen={isNavOpen} onOpenChange={setNavOpen}>
              <Button isIconOnly variant="ghost" aria-label="Open navigation">
                <Menu aria-hidden="true" className="size-5" />
              </Button>
              <Drawer.Backdrop>
                <Drawer.Content placement="left">
                  <Drawer.Dialog>
                    {/* flex-row explicitly: HeroUI's own header slot is a
                        column, so `items-center` would centre the lockup
                        horizontally and leave it out of line with everything
                        below it. The close trigger is absolutely positioned,
                        so the lockup is the only item in flow. */}
                    <Drawer.Header className="flex flex-row items-center gap-3">
                      <BrandLockup
                        surface="default"
                        className="text-ink"
                        tagline="Admin workspace"
                        taglineClassName="text-ink-muted"
                        wordmark={
                          <Drawer.Heading className="font-display text-[1.3rem] leading-none font-extrabold tracking-tight">
                            Join The Six
                          </Drawer.Heading>
                        }
                      />
                      <Drawer.CloseTrigger />
                    </Drawer.Header>
                    <Drawer.Body className="flex flex-col gap-4">
                      <div className="border-b border-border pb-4">
                        <EnvironmentChips variant="drawer" />
                      </div>
                      <AdminNavigation
                        variant="drawer"
                        onNavigate={() => setNavOpen(false)}
                      />
                    </Drawer.Body>
                  </Drawer.Dialog>
                </Drawer.Content>
              </Drawer.Backdrop>
            </Drawer>

            <div>
              <p className="jts-overline text-ink-muted">Join The Six</p>
              <strong className="text-sm font-bold">Control center</strong>
            </div>
          </div>

          <AdminUserMenu />
        </header>

        <AdminMain />
      </div>
    </div>
  );
}
