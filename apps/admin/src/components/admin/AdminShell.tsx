import { useState } from "react";
import { Button, Drawer } from "@heroui/react";
import { Menu } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { Link, Outlet, useLocation } from "react-router";

import { AdminNavigation } from "./AdminNavigation";
import { AdminUserMenu } from "./AdminUserMenu";

/**
 * The routed main region: the content column with the signature 200ms
 * opacity/8px-rise entrance. It re-runs per route (keyed by pathname) and
 * collapses to no motion when the viewer prefers reduced motion.
 */
function AdminMain() {
  const reduceMotion = useReducedMotion();
  const { pathname } = useLocation();

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className="mx-auto w-full max-w-content p-[clamp(1.25rem,3vw,2.5rem)]"
    >
      <motion.div
        key={pathname}
        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.2, ease: "easeOut" }}
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
 * full-height wine sidebar (brand, kicker, navigation, operator menu + the
 * static environment line) and no top bar. Small screens hide the sidebar and
 * surface a top bar whose hamburger opens the same navigation in a left drawer.
 * The operator menu and navigation components render in both places.
 */
export function AdminShell() {
  const [isNavOpen, setNavOpen] = useState(false);

  return (
    <div className="min-h-screen bg-canvas lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]">
      <aside className="hidden border-r border-sidebar-border bg-sidebar px-4 py-6 text-sidebar-fg lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col">
        <Link
          to="/admin"
          aria-label="Join The Six admin home"
          className="flex items-center gap-3 px-3 font-display text-[1.3rem] font-extrabold tracking-tight text-sidebar-fg no-underline"
        >
          <span className="brand-mark" aria-hidden="true" />
          <span>Join The Six</span>
        </Link>
        <p className="mt-2 mb-5 border-b border-sidebar-border px-3 pb-6 text-xs font-bold uppercase tracking-caps text-sidebar-fg-muted">
          Admin workspace
        </p>

        <AdminNavigation variant="sidebar" />

        <div className="mt-4 flex flex-col items-stretch gap-3 border-t border-sidebar-border pt-4">
          <AdminUserMenu className="w-full text-sidebar-fg" />
          <p className="flex items-center gap-2 px-3 text-xs font-semibold text-sidebar-fg-muted">
            <span className="status-dot" aria-hidden="true" />
            <span>Local environment</span>
          </p>
        </div>
      </aside>

      <div className="flex min-w-0 flex-col">
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
                      <p className="border-b border-border pb-4 text-xs font-bold uppercase tracking-caps text-ink-muted">
                        Local environment
                      </p>
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
              <p className="text-[0.7rem] font-extrabold uppercase tracking-caps text-ink-muted">
                Join The Six
              </p>
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
