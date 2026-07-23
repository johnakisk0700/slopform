# Frontend component inventory

Search this inventory before adding UI. Selection order: **reuse a matching
project `Jts*` contract → use the HeroUI primitive directly → compose a new
documented `Jts*` only for real repeated product behaviour → semantic HTML.**
Never wrap a HeroUI component just to rename its props.

## Shared UI (`src/components/ui/`)

| Component           | Contract                                   | Owns                                                                                     |
| ------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `JtsPageHeader.tsx` | [`jts-page-header.md`](jts-page-header.md) | One route's `h1` with the wine marker, eyebrow, description and route-owned actions      |
| `JtsStat.tsx`       | [`jts-stat.md`](jts-stat.md)               | One definition-list-safe metric: `dt`/`dd`, tone marker, decorative icon                 |
| `JtsDataTable.tsx`  | [`jts-data-table.md`](jts-data-table.md)   | Table naming, loading/empty/error states, overflow, toolbar and client sort + pagination |

`JtsDataTable` owns table states and framing; the page owns TanStack `ColumnDef`
columns, cell formatting, filters, row actions and API calls. `JtsStat` renders
inside a page-owned labelled `dl`. Add a prop or slot only after a real consumer
needs it, then update this inventory and the focused contract in the same change.

## Domain components (`src/components/admin/`)

Admin shell and interaction boundaries — documented inline here rather than with
their own contract file until one grows a reusable surface.

| Component                                                                             | Owner       | Owns                                                                                  |
| ------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------- |
| [`AdminShell.tsx`](../../../apps/admin/src/components/admin/AdminShell.tsx)           | Admin shell | Desktop wine sidebar / mobile drawer layout, skip target and the 200ms route entrance |
| [`AdminNavigation.tsx`](../../../apps/admin/src/components/admin/AdminNavigation.tsx) | Admin shell | Indexed nav landmark shared by sidebar and drawer via a `variant` prop; "Soon" stamps |
| [`AdminUserMenu.tsx`](../../../apps/admin/src/components/admin/AdminUserMenu.tsx)     | Admin shell | Operator identity popover and the light/dark/auto appearance control (`useTheme`)     |

`AdminNavigation` and `AdminUserMenu` mount twice (sidebar + drawer), so every
internal id comes from React's `useId`.

## References

Verified 2026-07-23: [@heroui/react](https://www.heroui.com/) 3.2.2,
[@tanstack/react-table](https://tanstack.com/table/v8) 8.21.3,
[lucide-react](https://lucide.dev/) 1.25.0. HeroUI has no provider — import
everything from `@heroui/react`; icons are lucide-react.
