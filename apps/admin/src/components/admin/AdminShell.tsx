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
 * The routed main region: the content column with the signature 200ms
 * opacity/8px-rise entrance. It re-runs per route (keyed by pathname) and
 * collapses to no motion when the viewer prefers reduced motion.
 */
function AdminMain() {
  const reduceMotion = useReducedMotion();
  const { pathname } = useLocation();
  const isAssistantRoute =
    pathname === "/admin/assistant" || pathname.startsWith("/admin/assistant/");

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={
        isAssistantRoute
          ? "relative min-h-0 w-full flex-1 overflow-hidden focus-visible:-outline-offset-2"
          : "mx-auto w-full max-w-content p-[clamp(1.25rem,3vw,2.5rem)]"
      }
    >
      <motion.div
        key={pathname}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
        className={isAssistantRoute ? "h-full min-h-0" : undefined}
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

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-canvas lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
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
        <header className="sticky top-0 z-30 flex min-h-[4.5rem] items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3 lg:hidden">
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
