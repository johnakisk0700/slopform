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

/** Deployment indicators shared by the sidebar and mobile drawer. */
function EnvironmentChips({ variant }: { variant: "sidebar" | "drawer" }) {
  // Use the surface foreground to keep the bypass label legible on both slabs.
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

function matchesRouteFamily(pathname: string, route: string): boolean {
  return pathname === route || pathname.startsWith(`${route}/`);
}

/** Route content with a reduced-motion-aware entrance. */
function AdminMain({
  pathname,
  isAssistant,
}: {
  pathname: string;
  isAssistant: boolean;
}) {
  const reduceMotion = useReducedMotion();
  const isFullHeight =
    isAssistant || matchesRouteFamily(pathname, "/admin/outbound");
  // Thread navigation keeps the assistant mounted with its scroll and draft state.
  const transitionKey = isAssistant ? "/admin/assistant" : pathname;

  return (
    <main
      id="main-content"
      tabIndex={-1}
      className={clsx(
        "w-full",
        // Desktop panes name their height because ancestors only have min-height.
        // On mobile, only the assistant fills the space below the shell's top bar.
        isFullHeight
          ? clsx(
              "relative overflow-hidden focus-visible:-outline-offset-2 lg:h-dvh",
              isAssistant ? "min-h-0 flex-1 lg:flex-none" : undefined,
            )
          : undefined,
        isAssistant
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

/** Desktop sidebar and mobile drawer share navigation, branding and account controls. */
export function AdminShell() {
  const [isNavOpen, setNavOpen] = useState(false);
  const { pathname } = useLocation();
  const isAssistant = matchesRouteFamily(pathname, "/admin/assistant");

  return (
    <div
      className={clsx(
        "flex min-h-0 flex-1 flex-col bg-canvas lg:grid lg:grid-cols-[17rem_minmax(0,1fr)]",
        // flex-none lets the explicit viewport height control #root's main axis.
        isAssistant ? "h-dvh flex-none overflow-hidden" : undefined,
      )}
    >
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
          {/* Sidebar hover/pressed fills keep the operator name legible on the inverse surface. */}
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
                    {/* Override the default column layout to align the lockup with the drawer body. */}
                    <Drawer.Header className="flex flex-row items-center gap-3">
                      <BrandLockup
                        surface="default"
                        className="text-ink"
                        tagline="Admin workspace"
                        taglineClassName="text-ink-muted"
                        wordmark={
                          <Drawer.Heading className="font-brand text-[1.3rem] leading-none font-extrabold tracking-tight">
                            Slopform
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

            <BrandLockup
              to="/admin"
              className="text-ink"
              wordmarkClassName="text-lg"
            />
          </div>

          <AdminUserMenu />
        </header>

        <AdminMain pathname={pathname} isAssistant={isAssistant} />
      </div>
    </div>
  );
}
