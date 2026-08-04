# JtsDataTable

Standard operational table: TanStack Table (core/sorted/pagination) skinned with
HeroUI `Table`. Owns accessible naming, loading/empty/error, keyboard-reachable
horizontal overflow and optional client paginator. Page owns columns, cell
formatting, row actions, fetching and domain rules — never fetch, retry or
server pagination here.

Source: [`JtsDataTable.tsx`](../../../apps/admin/src/components/ui/JtsDataTable.tsx)

## Contract

Generic over row type `T`.

| Prop | Type | Contract |
| ---- | ---- | -------- |
| `rows` | `readonly T[]` | Required. Presentation only — page fetches and shapes. |
| `columns` | `ColumnDef<T>[]` | Required. Page-supplied TanStack column defs. |
| `getRowId` | `(row: T, index) => string` | Required. Stable identity for sort/pagination keys. |
| `title` | `string` | Required. Visible `h2` and table accessible name. |
| `description` | `string \| null` | Optional caption; `aria-describedby`. |
| `loading` | `boolean` | Labelled skeleton in place of rows (`aria-busy`). |
| `error` | `string \| null` | Blocking error (no rows) or stale-data warning (rows present). |
| `emptyTitle` | `string` | Ready-but-empty heading. Default `"Nothing to show yet"`. |
| `emptyDescription` | `string` | Ready-but-empty copy. |
| `emptyIcon` | `ReactNode` | Optional empty mark; defaults to CSS six-dot motif. |
| `paginator` | `boolean` | Client pagination; hidden while unnecessary. |
| `pageSize` | `number` | Initial page size. Default `10`. |
| `rowsPerPageOptions` | `number[]` | Footer page-size choices. Default `[10, 25, 50]`. |
| `toolbarEnd` | `ReactNode` | Page-owned actions, right of the title. |
| `emptyActions` | `ReactNode` | Domain recovery for empty state. |
| `errorActions` | `ReactNode` | Domain recovery for error state. |

### Column contract (page-owned)

Plain TanStack `ColumnDef<T>` — `accessorKey`/`header`/`cell`, `enableSorting`.
Alignment via module augmentation:

```ts
// @tanstack/react-table ColumnMeta
meta?: { align?: "start" | "center" | "end" }
```

`meta.align` sets header and body (default `start`). First leaf column is the
row header (`isRowHeader`). Sortable when `ColumnDef` allows; surface reads
`getCanSort()`.

Alignment is applied twice: HeroUI's `SortableColumnHeader` is a `flex` row with
`space-between`, so `text-align` alone cannot end-align a sortable header — the
surface also passes a matching `justify-*`. `start` keeps HeroUI's default
(sort indicator on the far edge).

## States

```mermaid
flowchart TD
  In["rows + loading + error"] --> L{"loading?"}
  L -->|Yes| Skel["Skeleton rows, aria-busy"]
  L -->|No| E{"error?"}
  E -->|"error, no rows"| Full["Blocking error, role=alert"]
  E -->|"error, rows present"| Warn["Inline warning banner + rows"]
  E -->|No error| R{"rows?"}
  R -->|Empty| Empty["emptyIcon or brand-mark + emptyActions"]
  R -->|Populated| Table["Table + optional paginator footer"]
```

- **Loading** — skeleton body; scroll region `aria-busy`.
- **Blocking error** — no rows: centred `role="alert"` + `errorActions`.
- **Inline error** — rows kept: `role="alert"` warning banner above rows.
- **Empty** — `emptyIcon` (or brand mark), title, description, `emptyActions`.
- **Populated** — rows + footer when paginating.

## Sorting and pagination

- Client-side, single-column sort in local `SortingState`, bridged to HeroUI
  `sortDescriptor` / `onSortChange`. Active headers tint `text-primary`.
- Client pagination only when `paginator` is set. Footer (rows-per-page `Select`
  + compact `Pagination`) hidden unless multi-page or row count exceeds the
  smallest page-size option. Page numbers windowed: first, last, ±1 around
  current, with ellipses.

## Accessibility

- `section` `aria-labelledby` the title `h2`.
- Scroll container: focusable `role="region"` (`tabIndex=0`) labelled by title;
  `aria-busy` while loading.
- `Table.Content`: `aria-labelledby`, plus `aria-describedby` when `description`
  present.
- Status by text and tone, never colour alone.

## Invariants

- `getRowId` stable per row — keys sorting and pagination.
- Surface owns states, framing and a11y; never domain data, fetching, filtering
  or business rules.
- Rows may persist under `error` (stale warning); vanish under `loading`.
- TanStack's mutable table API cannot be safely compiler-memoized:
  `"use no memo"` + one line-local `react-hooks/incompatible-library`
  suppression. Do not widen that suppression.

## Extension points

- **Column** — consumer `ColumnDef[]` only; `meta.align` for numerics.
- **Sortable** — `enableSorting` on the `ColumnDef`.
- Shared sorting/selection/lazy-pagination props only when a second real table
  needs them.

## References

Verified 2026-07-23:

- [@heroui/react](https://www.heroui.com/) 3.2.2 —
  [Table](https://www.heroui.com/docs/react/components/table),
  [Pagination](https://www.heroui.com/docs/react/components/pagination),
  [Select](https://www.heroui.com/docs/react/components/select).
- [@tanstack/react-table](https://tanstack.com/table/v8) 8.21.3 —
  [Column defs](https://tanstack.com/table/v8/docs/guide/column-defs),
  [Sorting](https://tanstack.com/table/v8/docs/guide/sorting),
  [Pagination](https://tanstack.com/table/v8/docs/guide/pagination).
- [React Compiler directives](https://react.dev/reference/react-compiler/directives) —
  function-local `"use no memo"`.
