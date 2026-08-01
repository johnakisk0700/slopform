import { useState } from "react";
import { Button, Drawer } from "@heroui/react";
import { Menu } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Link, Outlet, useLocation } from "react-router";

import { env } from "../../lib/env";
import { AdminNavigation } from "./AdminNavigation";
import { AdminUserMenu } from "./AdminUserMenu";

/**
 * The environment block under the brand mark: which deployment this is, and —
 * when it is on — that the local authentication bypass is answering for the
 * operator. It is the shell's only environment indicator, so it renders in
 * both places the brand mark does (wine sidebar, light drawer) with the tones
 * of each surface.
 */
function EnvironmentBlock({ variant }: { variant: "sidebar" | "drawer" }) {
  const muted =
    variant === "sidebar" ? "text-sidebar-fg-muted" : "text-ink-muted";
  const strong = variant === "sidebar" ? "text-sidebar-fg" : "text-ink";

  return (
    <>
      <p className={`text-xs font-bold uppercase tracking-caps ${muted}`}>
        Admin workspace
      </p>
      <p className={`flex items-center gap-2 text-xs font-semibold ${muted}`}>
        <span className="status-dot" aria-hidden="true" />
        <span>Local environment</span>
      </p>
      {env.authDevBypass ? (
        // Full-strength foreground rather than a warning tone: both verified
        // pairs (text on wine, text on surface) clear AA, and warning-on-surface
        // is not one of the measured pairings.
        <p className={`jts-overline ${strong}`}>Authentication bypass active</p>
      ) : null}
    </>
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
 * full-height wine sidebar (brand, kicker, {@link EnvironmentBlock},
 * navigation, operator menu) and no top bar. Small screens hide the sidebar and
 * surface a top bar whose hamburger opens the same navigation in a left drawer.
 * The environment block, operator menu and navigation render in both places.
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
        <Link
          to="/admin"
          aria-label="Join The Six admin home"
          className="flex items-center gap-3 px-3 font-display text-[1.3rem] font-extrabold tracking-tight text-sidebar-fg no-underline"
        >
          <span className="brand-mark" aria-hidden="true" />
          <span>Join The Six</span>
        </Link>
        <div className="mt-2 mb-5 grid gap-1.5 border-b border-sidebar-border px-3 pb-6">
          <EnvironmentBlock variant="sidebar" />
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
                    <Drawer.Header className="flex items-center justify-between gap-3">
                      <div className="flex items-center gap-3 text-ink">
                        <span className="brand-mark" aria-hidden="true" />
                        <Drawer.Heading className="font-display text-[1.3rem] font-extrabold tracking-tight">
                          Join The Six
                        </Drawer.Heading>
                      </div>
                      <Drawer.CloseTrigger />
                    </Drawer.Header>
                    <Drawer.Body className="flex flex-col gap-4">
                      <div className="grid gap-1.5 border-b border-border pb-4">
                        <EnvironmentBlock variant="drawer" />
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
