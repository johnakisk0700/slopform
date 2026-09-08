import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Calendar,
  LayoutGrid,
  SendHorizontal,
  Shield,
  SwatchBook,
  Users,
} from "lucide-react";
import { NavLink } from "react-router";

/** Where the nav is rendered — it lives on both the wine sidebar and, at small
 *  widths, the light drawer surface, so tones flip per context. */
type NavVariant = "sidebar" | "drawer";

interface NavItem {
  label: string;
  Icon: LucideIcon;
  to: string;
}

/** Shipped admin destinations in product order. */
const NAV_ITEMS: readonly NavItem[] = [
  { label: "Overview", Icon: LayoutGrid, to: "/admin" },
  { label: "AI assistant", Icon: Bot, to: "/admin/assistant" },
  { label: "Events", Icon: Calendar, to: "/admin/events" },
  { label: "Participants", Icon: Users, to: "/admin/participants" },
  { label: "Feedback & safety", Icon: Shield, to: "/admin/feedback" },
  // A sibling of feedback keeps only one navigation row current.
  { label: "Outbound queue", Icon: SendHorizontal, to: "/admin/outbound" },
];

/** Development tools match the route gate in App.tsx and stay outside product numbering. */
const DEV_NAV_ITEMS: readonly NavItem[] = import.meta.env.DEV
  ? [{ label: "Cookbook", Icon: SwatchBook, to: "/admin/cookbook" }]
  : [];

interface NavVariantStyles {
  /** Idle text tone + the enabled hover treatment. */
  link: string;
  hover: string;
  /** Active fill / text / weight (the aria-current row). */
  active: string;
  index: string;
  activeIndex: string;
  iconIdle: string;
  /** Hairline above a trailing group, in this surface's own border tone. */
  divider: string;
}

const VARIANTS: Record<NavVariant, NavVariantStyles> = {
  sidebar: {
    link: "text-sidebar-fg-muted",
    hover: "hover:bg-sidebar-hover hover:text-sidebar-fg",
    active: "bg-sidebar-active font-bold text-sidebar-active-fg",
    index: "opacity-45",
    activeIndex: "font-extrabold text-sidebar-active-index opacity-100",
    iconIdle: "opacity-75",
    divider: "border-sidebar-border",
  },
  drawer: {
    link: "text-ink-muted",
    hover: "hover:bg-primary-soft hover:text-primary",
    active: "bg-primary-soft font-bold text-primary",
    index: "opacity-45",
    activeIndex: "font-extrabold text-primary opacity-100",
    iconIdle: "opacity-80",
    divider: "border-border",
  },
};

const LINK_BASE =
  "flex min-h-[2.75rem] w-full items-center gap-3 rounded-md px-3 py-[0.65rem] text-sm font-semibold no-underline transition-colors";
const INDEX_BASE =
  "w-[1.1rem] shrink-0 text-[length:var(--jts-text-2xs)] font-semibold tabular-nums";
const ICON_BASE = "size-[1.1rem] shrink-0";

interface AdminNavigationProps {
  /** Surface the nav sits on. Defaults to the wine sidebar. */
  variant?: NavVariant;
  /** Fired after a link is followed — the drawer uses it to close itself. */
  onNavigate?: () => void;
}

/** Null numerals keep development icons aligned with the numbered destinations. */
function NavRow({
  item,
  numeral,
  styles,
  onNavigate,
}: {
  item: NavItem;
  numeral: string | null;
  styles: NavVariantStyles;
  onNavigate?: (() => void) | undefined;
}) {
  const { Icon } = item;

  return (
    <NavLink
      to={item.to}
      end={item.to === "/admin"}
      onClick={onNavigate}
      className={({ isActive }) =>
        clsx(LINK_BASE, styles.hover, isActive ? styles.active : styles.link)
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
  );
}

/** Shared sidebar/drawer landmark with a lit index on the active destination. */
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
        {NAV_ITEMS.map((item, position) => (
          <li key={item.label}>
            <NavRow
              item={item}
              numeral={String(position + 1).padStart(2, "0")}
              styles={styles}
              onNavigate={onNavigate}
            />
          </li>
        ))}
      </ul>

      {DEV_NAV_ITEMS.length > 0 ? (
        <div className={clsx("mt-3 border-t pt-3", styles.divider)}>
          <p className={clsx("mb-1 px-3 jts-overline", styles.link)}>
            Development
          </p>
          <ul className="flex flex-col gap-0.5">
            {DEV_NAV_ITEMS.map((item) => (
              <li key={item.label}>
                <NavRow
                  item={item}
                  numeral={null}
                  styles={styles}
                  onNavigate={onNavigate}
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </nav>
  );
}
