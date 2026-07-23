import { useId, useRef, useState } from "react";
import {
  Avatar,
  Button,
  Popover,
  Separator,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import type { LucideIcon } from "lucide-react";
import { LogOut, Monitor, Moon, Sun } from "lucide-react";

import { useTheme, type ThemeMode } from "../../lib/useTheme";

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

export interface AdminUserMenuProps {
  /**
   * Context styling for the trigger row — the shell passes width / text-color
   * tweaks so the same button reads on the wine sidebar footer and the light
   * top bar (e.g. `w-full text-sidebar-fg`). The base already carries an
   * inherit-friendly quiet hover, so a colored hover is not required here.
   */
  className?: string;
}

/**
 * The operator menu: a quiet avatar-and-name trigger that opens a popover with
 * the identity block, an appearance switcher bound to {@link useTheme}, and the
 * (disabled) sign-out affordance.
 *
 * It mounts twice — sidebar footer and small-screen top bar — so every internal
 * id comes from {@link useId}, and the trigger's `aria-expanded` /
 * `aria-controls` are hand-wired to the popover's open state.
 */
export function AdminUserMenu({ className }: AdminUserMenuProps) {
  const { mode, setMode } = useTheme();

  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const panelId = useId();
  const themeLabelId = useId();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        // Accessible name leads with the visible operator label so speech-input
        // users can target it by the name they see (WCAG 2.5.3 Label in Name);
        // the trailing context keeps the <sm icon-only state meaningfully named.
        aria-label="Spyridoula — account and appearance"
        aria-haspopup="dialog"
        aria-controls={panelId}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={
          "inline-flex items-center gap-3 rounded-md px-2 py-1.5 text-left " +
          "transition-colors hover:bg-[color-mix(in_srgb,currentcolor_8%,transparent)]" +
          (className ? ` ${className}` : "")
        }
      >
        {/* Rounded square: the circle motif stays reserved for the brand mark. */}
        <Avatar
          color="accent"
          variant="soft"
          size="md"
          aria-hidden="true"
          className="rounded-md"
        >
          <Avatar.Fallback>Σ</Avatar.Fallback>
        </Avatar>
        <span className="hidden text-sm font-semibold sm:inline">
          Spyridoula
        </span>
      </button>

      <Popover.Content
        aria-label="Account and appearance"
        triggerRef={triggerRef}
        isOpen={open}
        onOpenChange={setOpen}
        // Clicks on the trigger are owned by its own toggle handler — excluding
        // it here prevents the outside-dismiss from fighting the re-open.
        shouldCloseOnInteractOutside={(element) =>
          !triggerRef.current?.contains(element)
        }
        placement="bottom"
        className="w-[min(20rem,calc(100vw-2rem))] p-4 outline-none"
      >
        {/* The controlled region the trigger's aria-controls points at. */}
        <div id={panelId} className="grid gap-4">
          <div className="flex items-center gap-3">
            <Avatar
              color="accent"
              variant="soft"
              size="lg"
              aria-hidden="true"
              className="rounded-md"
            >
              <Avatar.Fallback>Σ</Avatar.Fallback>
            </Avatar>
            <div className="grid">
              <strong className="text-base font-bold">Spyridoula</strong>
              <span className="text-sm text-ink-muted">Operator</span>
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
                <ToggleButton key={value} id={value} className="rounded-md">
                  <Icon aria-hidden="true" className="size-4" />
                  {label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
          </div>

          <Separator />

          <div className="grid justify-items-start gap-2">
            <Button variant="ghost" size="sm" isDisabled>
              <LogOut aria-hidden="true" className="size-4" />
              Sign out
            </Button>
            <p className="text-xs text-ink-subtle">
              Sign-in arrives with the backend session contract.
            </p>
          </div>
        </div>
      </Popover.Content>
    </>
  );
}
