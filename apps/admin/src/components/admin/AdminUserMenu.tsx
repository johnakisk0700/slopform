import { useId, useState } from "react";
import { useClerk, useUser } from "@clerk/react";
import {
  Avatar,
  Button,
  Popover,
  Separator,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { clsx } from "clsx";
import type { LucideIcon } from "lucide-react";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";

import { env } from "../../lib/env";
import { PALETTES, usePalette } from "../../lib/usePalette";
import { useTheme, type ThemeMode } from "../../lib/useTheme";

/**
 * One choice chip in the menu — appearance or theme.
 *
 * HeroUI's default toggle paints its unselected state with the page's soft
 * fill, which inside a floating white card read as a row of unfinished beige
 * blocks. Unselected is therefore a hairline over nothing, and the tinted fill
 * is spent only on the choice that is actually in force. The padding is `2`,
 * not the component's own `4`: these live in a two-column grid roughly 8rem
 * wide, where 16px a side left «House Wine» touching both edges.
 */
const CHOICE_CHIP =
  "justify-center gap-1.5 rounded-md border border-border bg-transparent px-2 text-ink " +
  "data-[selected]:border-primary-border data-[selected]:bg-primary-soft data-[selected]:text-primary";

/** The three appearance choices, in display order (Auto = the `system` mode). */
const THEME_OPTIONS: ReadonlyArray<{
  value: ThemeMode;
  label: string;
  Icon: LucideIcon;
}> = [
  { value: "light", label: "Light", Icon: Sun },
  { value: "dark", label: "Dark", Icon: Moon },
  { value: "system", label: "Auto", Icon: Monitor },
];

interface AdminUserMenuProps {
  /**
   * Context styling for the trigger row — the shell passes width / text-colour
   * tweaks so the same button reads on the wine sidebar footer and the light
   * top bar (e.g. `w-full text-sidebar-fg`).
   */
  className?: string;
}

/**
 * The operator menu: a quiet avatar-and-name trigger that opens a popover with
 * the identity block, an appearance switcher bound to {@link useTheme}, and the
 * (disabled) sign-out affordance.
 *
 * `Popover` is the react-aria dialog trigger: it owns the open state and wires
 * the trigger's `aria-haspopup` / `aria-expanded` / focus management, so this
 * component holds none of that by hand. `Popover.Dialog` is required — it is
 * the labelled dialog inside the positioned `Popover.Content` surface.
 *
 * It mounts twice (sidebar footer and small-screen top bar), so the heading id
 * comes from {@link useId}.
 */
export function AdminUserMenu(props: AdminUserMenuProps) {
  return env.authDevBypass ? (
    <AdminUserMenuContent
      {...props}
      displayName="Local developer"
      identityLabel="Authentication bypass"
    />
  ) : (
    <ClerkAdminUserMenu {...props} />
  );
}

function ClerkAdminUserMenu(props: AdminUserMenuProps) {
  const { signOut } = useClerk();
  const { user } = useUser();
  const displayName =
    user?.fullName ??
    user?.firstName ??
    user?.primaryEmailAddress?.emailAddress ??
    "Operator";
  const identityLabel = user?.primaryEmailAddress?.emailAddress ?? "Admin";

  return (
    <AdminUserMenuContent
      {...props}
      displayName={displayName}
      identityLabel={identityLabel}
      onSignOut={() => signOut({ redirectUrl: "/sign-in" })}
    />
  );
}

interface AdminUserMenuContentProps extends AdminUserMenuProps {
  readonly displayName: string;
  readonly identityLabel: string;
  readonly onSignOut?: (() => Promise<void>) | undefined;
}

function AdminUserMenuContent({
  className,
  displayName,
  identityLabel,
  onSignOut,
}: AdminUserMenuContentProps) {
  const { mode, setMode } = useTheme();
  const { palette, setPalette } = usePalette();
  const themeLabelId = useId();
  const paletteLabelId = useId();
  const [isSigningOut, setSigningOut] = useState(false);
  const [signOutError, setSignOutError] = useState(false);
  const avatarFallback =
    displayName.trim().charAt(0).toLocaleUpperCase() || "A";

  return (
    <Popover>
      <Button
        variant="ghost"
        // The accessible name leads with the visible operator label so
        // speech-input users can target it by the name they see (WCAG 2.5.3),
        // and it stays meaningful when the label is hidden on small screens.
        aria-label={`${displayName} — account and appearance`}
        // `h-auto` releases Button's fixed 2.5rem height so the hover surface
        // covers the whole row; the padding and the 2rem avatar then size it to
        // the 2.75rem rhythm of the navigation items.
        className={`inline-flex h-auto min-h-[2.75rem] items-center justify-start gap-3 rounded-md px-3 py-1.5 text-left${
          className ? ` ${className}` : ""
        }`}
      >
        {/* Rounded square: the circle motif stays reserved for the brand mark. */}
        <Avatar
          color="accent"
          variant="soft"
          size="sm"
          aria-hidden="true"
          className="rounded-md"
        >
          <Avatar.Fallback>{avatarFallback}</Avatar.Fallback>
        </Avatar>
        <span className="hidden text-sm font-semibold sm:inline">
          {displayName}
        </span>
      </Button>

      <Popover.Content
        placement="bottom"
        className="w-[min(20rem,calc(100vw-2rem))]"
      >
        <Popover.Dialog
          aria-label="Account and appearance"
          className="grid gap-4"
        >
          <div className="flex items-center gap-3">
            <Avatar
              color="accent"
              variant="soft"
              size="lg"
              aria-hidden="true"
              className="rounded-md"
            >
              <Avatar.Fallback>{avatarFallback}</Avatar.Fallback>
            </Avatar>
            <div className="grid">
              <strong className="text-base font-bold">{displayName}</strong>
              <span className="text-sm text-ink-muted">{identityLabel}</span>
            </div>
          </div>

          <Separator />

          <div className="grid gap-2">
            <span
              id={themeLabelId}
              className="text-xs font-bold tracking-caps text-ink-muted uppercase"
            >
              Appearance
            </span>
            <ToggleButtonGroup
              aria-labelledby={themeLabelId}
              selectionMode="single"
              disallowEmptySelection
              isDetached
              fullWidth
              selectedKeys={[mode]}
              onSelectionChange={(keys) => {
                const [next] = keys;
                if (next === "light" || next === "dark" || next === "system") {
                  setMode(next);
                }
              }}
            >
              {THEME_OPTIONS.map(({ value, label, Icon }) => (
                <ToggleButton key={value} id={value} className={CHOICE_CHIP}>
                  <Icon aria-hidden="true" className="size-4 shrink-0" />
                  {label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </div>

          <div className="grid gap-2">
            <span
              id={paletteLabelId}
              className="text-xs font-bold tracking-caps text-ink-muted uppercase"
            >
              Theme
            </span>
            {/* A 2×3 grid rather than a row: six names in a 20rem popover
                would wrap mid-word, and a select would hide five of the six.
                The names are the whole affordance — each is a palette from
                palettes.css, previewed by simply being applied. */}
            <ToggleButtonGroup
              aria-labelledby={paletteLabelId}
              selectionMode="single"
              disallowEmptySelection
              isDetached
              // `w-full` on the group too: HeroUI's group wrapper is
              // fit-content, so without it the grid packs to its own width
              // and stops short of the dialog's right edge.
              className="grid w-full grid-cols-2 gap-1"
              selectedKeys={[palette]}
              onSelectionChange={(keys) => {
                const [next] = keys;
                if (typeof next === "string") {
                  setPalette(next);
                }
              }}
            >
              {PALETTES.map(({ id, label }) => (
                // `w-full`: the grid sizes the cells, so each button must fill
                // its cell or the column edge goes ragged — the group's
                // `fullWidth` only evens out a single flex row.
                <ToggleButton
                  key={id}
                  id={id}
                  className={clsx(CHOICE_CHIP, "w-full")}
                >
                  {label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </div>

          <Separator />

          {onSignOut ? (
            <div className="grid justify-items-start gap-2">
              <Button
                variant="ghost"
                size="sm"
                isDisabled={isSigningOut}
                onPress={() => {
                  setSigningOut(true);
                  setSignOutError(false);
                  void onSignOut()
                    .catch(() => setSignOutError(true))
                    .finally(() => setSigningOut(false));
                }}
              >
                <LogOut aria-hidden="true" className="size-4" />
                {isSigningOut ? "Signing out…" : "Sign out"}
              </Button>
              {signOutError ? (
                <p role="alert" className="text-xs text-danger">
                  Sign-out failed. Try again.
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-xs font-semibold text-warning">
              Sign-in is disabled for this local development session.
            </p>
          )}
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
