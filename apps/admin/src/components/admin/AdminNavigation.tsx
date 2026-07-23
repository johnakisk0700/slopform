import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  Calendar,
  CreditCard,
  LayoutGrid,
  Network,
  Send,
  Shield,
  Ticket,
  Users,
} from "lucide-react";
import { NavLink } from "react-router";

/** Where the nav is rendered — it lives on both the wine sidebar and, at small
 *  widths, the light drawer surface, so tones flip per context. */
type NavVariant = "sidebar" | "drawer";

interface NavItem {
  label: string;
  Icon: LucideIcon;
  /** Present only for shipped destinations; absent items render as "Soon". */
  to?: string;
}

/** The eight admin areas, in ledger order. Only Overview is live today. */
const NAV_ITEMS: readonly NavItem[] = [
  { label: "Overview", Icon: LayoutGrid, to: "/admin" },
  { label: "Events", Icon: Calendar },
  { label: "Participants", Icon: Users },
  { label: "Bookings", Icon: Ticket },
  { label: "Tables & matching", Icon: Network },
  { label: "Payments", Icon: CreditCard },
  { label: "Communications", Icon: Send },
  { label: "Feedback & safety", Icon: Shield },
];

interface NavVariantStyles {
  /** Idle text tone + the enabled hover treatment. */
  link: string;
  hover: string;
  /** Active fill / text / weight (the aria-current row). */
  active: string;
  index: string;
  activeIndex: string;
  iconIdle: string;
  soon: string;
}

const VARIANTS: Record<NavVariant, NavVariantStyles> = {
  sidebar: {
    link: "text-sidebar-fg-muted",
    hover: "hover:bg-sidebar-hover hover:text-sidebar-fg",
    active: "bg-sidebar-active font-bold text-sidebar-active-fg",
    index: "opacity-45",
    activeIndex: "font-extrabold text-sidebar-active-index opacity-100",
    iconIdle: "opacity-75",
    soon: "text-sidebar-fg-muted",
  },
  drawer: {
    link: "text-ink-muted",
    hover: "hover:bg-primary-soft hover:text-primary",
    active: "bg-primary-soft font-bold text-primary",
    index: "opacity-45",
    activeIndex: "font-extrabold text-primary opacity-100",
    iconIdle: "opacity-80",
    soon: "text-ink-muted",
  },
};

const LINK_BASE =
  "flex min-h-[2.75rem] w-full items-center gap-3 rounded-md px-3 py-[0.65rem] text-sm font-semibold no-underline transition-colors";
const INDEX_BASE =
  "w-[1.1rem] shrink-0 text-[0.65rem] font-semibold tabular-nums";
const ICON_BASE = "size-[1.1rem] shrink-0";
const SOON_BASE =
  "ml-auto rounded-sm border border-[color-mix(in_srgb,currentcolor_40%,transparent)] px-[0.45rem] py-[0.1rem] text-[0.7rem] font-extrabold uppercase tracking-[0.05em]";

export interface AdminNavigationProps {
  /** Surface the nav sits on. Defaults to the wine sidebar. */
  variant?: NavVariant;
  /** Fired after a link is followed — the drawer uses it to close itself. */
  onNavigate?: () => void;
}

/**
 * The admin navigation landmark: eight indexed areas with the lit-index motif
 * on the active row. One component serves both the desktop sidebar and the
 * mobile drawer via {@link AdminNavigationProps.variant}; disabled areas carry
 * a "Soon" stamp and are inert but announced.
 */
export function AdminNavigation({
  variant = "sidebar",
  onNavigate,
}: AdminNavigationProps) {
  const styles = VARIANTS[variant];

  return (
    <nav
      aria-label="Admin navigation"
      className={clsx(
        "flex flex-col",
        variant === "sidebar" && "min-h-0 flex-1 overflow-y-auto",
      )}
    >
      <ul className="flex flex-col gap-0.5">
        {NAV_ITEMS.map((item, position) => {
          const numeral = String(position + 1).padStart(2, "0");
          const { Icon } = item;

          return (
            <li key={item.label}>
              {item.to ? (
                <NavLink
                  to={item.to}
                  end
                  onClick={onNavigate}
                  className={({ isActive }) =>
                    clsx(
                      LINK_BASE,
                      styles.hover,
                      isActive ? styles.active : styles.link,
                    )
                  }
                >
                  {({ isActive }) => (
                    <>
                      <span
                        aria-hidden="true"
                        className={clsx(
                          INDEX_BASE,
                          isActive ? styles.activeIndex : styles.index,
                        )}
                      >
                        {numeral}
                      </span>
                      <Icon
                        aria-hidden="true"
                        className={clsx(
                          ICON_BASE,
                          isActive ? "opacity-100" : styles.iconIdle,
                        )}
                      />
                      <span>{item.label}</span>
                    </>
                  )}
                </NavLink>
              ) : (
                <span
                  aria-disabled="true"
                  className={clsx(
                    LINK_BASE,
                    styles.link,
                    "cursor-not-allowed opacity-60",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={clsx(INDEX_BASE, styles.index)}
                  >
                    {numeral}
                  </span>
                  <Icon
                    aria-hidden="true"
                    className={clsx(ICON_BASE, styles.iconIdle)}
                  />
                  <span>{item.label}</span>
                  <small className={clsx(SOON_BASE, styles.soon)}>Soon</small>
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
