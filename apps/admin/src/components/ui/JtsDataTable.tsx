import { useId, useState, type ReactNode } from "react";
import { ListBox, Pagination, Select, Table } from "@heroui/react";
import {
  flexRender,
  getCoreRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type PaginationState,
  type Row,
  type RowData,
  type SortingState,
} from "@tanstack/react-table";
import { ChevronLeft, ChevronRight, TriangleAlert } from "lucide-react";
import clsx from "clsx";

/**
 * Column meta escape hatch. The page owns columns; alignment is the one piece of
 * presentation the table surface needs from each `ColumnDef` to line numeric
 * ledgers up under their headers.
 */
declare module "@tanstack/react-table" {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- signature must mirror the augmented interface.
  interface ColumnMeta<TData extends RowData, TValue> {
    /** Horizontal alignment applied to this column's header and body cells. */
    align?: "start" | "center" | "end";
  }
}

export interface JtsDataTableProps<T> {
  /** Rows to display. Presentation only — the page owns fetching and shaping. */
  rows: readonly T[];
  /** TanStack column definitions supplied by the page. */
  columns: ColumnDef<T>[];
  /** Stable row identity — required so sorting and pagination keep row keys. */
  getRowId: (row: T, index: number) => string;
  /** Visible and accessible name for the table. */
  title: string;
  /** Optional visible description, wired as the table's `aria-describedby`. */
  description?: string | null;
  /** Shows the labelled loading state in place of rows. */
  loading?: boolean;
  /** Blocking error (no rows) or a stale-data warning banner (rows present). */
  error?: string | null;
  /** Ready-but-empty heading. */
  emptyTitle?: string;
  /** Ready-but-empty supporting copy. */
  emptyDescription?: string;
  /**
   * Optional decorative mark for the empty state. Defaults to the six-dot
   * brand mark; pages may pass a muted lucide glyph for domain character.
   */
  emptyIcon?: ReactNode;
  /** Enables client-side pagination, hidden while it is unnecessary. */
  paginator?: boolean;
  /** Initial page size. */
  pageSize?: number;
  /** Page-size choices offered in the footer select. */
  rowsPerPageOptions?: number[];
  /** Page-owned table actions, right-aligned in the toolbar. */
  toolbarEnd?: ReactNode;
  /** Domain-owned recovery controls for the empty state. */
  emptyActions?: ReactNode;
  /** Domain-owned recovery controls for the error state. */
  errorActions?: ReactNode;
}

type PageItem = number | "start-ellipsis" | "end-ellipsis";

/** Text-alignment utility for a column's `meta.align`. */
function alignClass(align: "start" | "center" | "end" | undefined): string {
  if (align === "center") return "text-center";
  if (align === "end") return "text-right";
  return "text-left";
}

/**
 * The same alignment, said again in flex terms for sortable headers.
 *
 * HeroUI lays `Table.SortableColumnHeader` out as `flex` with
 * `justify-content: space-between`, so it fills the column and `text-align` on
 * the cell cannot move it — a sortable numeric column ended up with its header
 * pinned left above right-aligned figures. `start` keeps the default, which is
 * what pushes the sort indicator to the far edge of a normal column.
 */
function justifyClass(
  align: "start" | "center" | "end" | undefined,
): string | undefined {
  if (align === "center") return "justify-center gap-1.5";
  if (align === "end") return "justify-end gap-1.5";
  return undefined;
}

/** Compact page list with a first page, last page and a window around the current page. */
function buildPageItems(current: number, total: number): PageItem[] {
  const items: PageItem[] = [1];
  const left = Math.max(2, current - 1);
  const right = Math.min(total - 1, current + 1);
  if (left > 2) items.push("start-ellipsis");
  for (let page = left; page <= right; page += 1) items.push(page);
  if (right < total - 1) items.push("end-ellipsis");
  if (total > 1) items.push(total);
  return items;
}

/**
 * `JtsDataTable` is the standard operational table surface: a TanStack headless
 * core (sorting, client pagination, row model) skinned with the HeroUI Table.
 * It owns accessible naming, the loading/empty/error states, keyboard-reachable
 * horizontal overflow and the optional paginator. The page owns columns,
 * formatting, row actions, fetching and domain rules.
 */
export function JtsDataTable<T>({
  rows,
  columns,
  getRowId,
  title,
  description = null,
  loading = false,
  error = null,
  emptyTitle = "Nothing to show yet",
  emptyDescription = "Rows will appear here when they are available.",
  emptyIcon = null,
  paginator = false,
  pageSize = 10,
  rowsPerPageOptions = [10, 25, 50],
  toolbarEnd = null,
  emptyActions = null,
  errorActions = null,
}: JtsDataTableProps<T>) {
  // TanStack Table returns an intentionally mutable API with methods that are
  // unsafe for compiler memoization. Keep that boundary inside this component.
  "use no memo";

  const titleId = useId();
  const descriptionId = useId();
  const [sorting, setSorting] = useState<SortingState>([]);
  const [pagination, setPagination] = useState<PaginationState>({
    pageIndex: 0,
    pageSize,
  });

  // eslint-disable-next-line react-hooks/incompatible-library -- The explicit compiler opt-out above contains TanStack's non-memoizable table API locally.
  const table = useReactTable<T>({
    data: rows as T[],
    columns,
    getRowId,
    state: { sorting, pagination },
    onSortingChange: setSorting,
    onPaginationChange: setPagination,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    ...(paginator ? { getPaginationRowModel: getPaginationRowModel() } : {}),
  });

  // The last header group holds the leaf columns (this surface renders flat columns).
  const leafHeaders = table.getHeaderGroups().at(-1)?.headers ?? [];
  const firstColumnId = leafHeaders[0]?.column.id;

  const hasDescription = Boolean(description);
  const hasError = Boolean(error) && !loading;
  const showInlineError = hasError && rows.length > 0;
  const showFullError = hasError && rows.length === 0;
  // Mirrors the Vue contract: the table is present while loading, whenever there
  // is no error, or whenever rows still exist under an error.
  const showTable = loading || !error || rows.length > 0;

  const activeSort = sorting[0];
  const sortDescriptorProps: {
    sortDescriptor?: { column: string; direction: "ascending" | "descending" };
  } = activeSort
    ? {
        sortDescriptor: {
          column: activeSort.id,
          direction: activeSort.desc ? "descending" : "ascending",
        },
      }
    : {};

  const bodyItems: Row<T>[] = loading ? [] : table.getRowModel().rows;

  const pageCount = table.getPageCount();
  const currentPage = pagination.pageIndex + 1;
  const smallestOption =
    rowsPerPageOptions.length > 0 ? Math.min(...rowsPerPageOptions) : pageSize;
  const showFooter =
    paginator &&
    !loading &&
    rows.length > 0 &&
    (pageCount > 1 || rows.length > smallestOption);
  const pageItems = pageCount > 1 ? buildPageItems(currentPage, pageCount) : [];

  const errorBody = (
    <>
      <TriangleAlert
        aria-hidden="true"
        className="mt-[0.18rem] size-5 shrink-0"
      />
      <div className="min-w-0">
        <h3 className="mb-1 text-base font-bold">Could not load this table</h3>
        <p className="text-sm text-ink-muted">{error}</p>
        {errorActions ? (
          <div className="mt-4 flex flex-wrap gap-2">{errorActions}</div>
        ) : null}
      </div>
    </>
  );

  return (
    <section
      aria-labelledby={titleId}
      className="min-w-0 overflow-hidden rounded-md border border-border bg-surface"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-5 py-4 max-sm:flex-col max-sm:items-start">
        <div className="min-w-0">
          <h2
            id={titleId}
            className="text-[1.05rem] font-bold tracking-tight text-ink"
          >
            {title}
          </h2>
          {hasDescription ? (
            <p id={descriptionId} className="mt-1 text-sm text-ink-muted">
              {description}
            </p>
          ) : null}
        </div>
        {toolbarEnd ? (
          <div className="flex flex-wrap gap-2 max-sm:w-full">{toolbarEnd}</div>
        ) : null}
      </div>

      {showInlineError ? (
        <div
          role="alert"
          className="grid grid-cols-[auto_minmax(0,1fr)] gap-4 border-b border-[color-mix(in_srgb,currentcolor_40%,transparent)] bg-danger-soft px-5 py-4 text-danger"
        >
          {errorBody}
        </div>
      ) : null}

      {showFullError ? (
        <div
          role="alert"
          className="grid min-h-60 grid-cols-[auto_minmax(0,1fr)] place-content-center gap-4 p-8 text-danger"
        >
          {errorBody}
        </div>
      ) : null}

      {showTable ? (
        <>
          <Table variant="secondary">
            <Table.ScrollContainer
              role="region"
              tabIndex={0}
              aria-labelledby={titleId}
              aria-busy={loading}
              className="focus-visible:-outline-offset-2"
            >
              <Table.Content
                aria-labelledby={titleId}
                {...(hasDescription
                  ? { "aria-describedby": descriptionId }
                  : {})}
                {...sortDescriptorProps}
                onSortChange={(descriptor) => {
                  setSorting([
                    {
                      id: String(descriptor.column),
                      desc: descriptor.direction === "descending",
                    },
                  ]);
                }}
                className="min-w-[44rem] tabular-nums"
              >
                <Table.Header>
                  {leafHeaders.map((header) => {
                    const canSort = header.column.getCanSort();
                    const sorted = header.column.getIsSorted();
                    const sortDirection =
                      sorted === "asc"
                        ? "ascending"
                        : sorted === "desc"
                          ? "descending"
                          : undefined;
                    const align = header.column.columnDef.meta?.align;
                    const rawHeader = header.column.columnDef.header;
                    const content = header.isPlaceholder
                      ? null
                      : flexRender(rawHeader, header.getContext());
                    return (
                      <Table.Column
                        key={header.column.id}
                        id={header.column.id}
                        isRowHeader={header.column.id === firstColumnId}
                        allowsSorting={canSort}
                        {...(typeof rawHeader === "string"
                          ? { textValue: rawHeader }
                          : {})}
                        className={clsx(
                          "rounded-none bg-surface-sunken px-4 py-3 align-middle text-[0.7rem] font-extrabold tracking-[0.08em] whitespace-nowrap uppercase",
                          alignClass(align),
                          sorted ? "text-primary" : "text-ink-muted",
                        )}
                      >
                        {canSort ? (
                          <Table.SortableColumnHeader
                            className={justifyClass(align)}
                            {...(sortDirection ? { sortDirection } : {})}
                          >
                            {content}
                          </Table.SortableColumnHeader>
                        ) : (
                          content
                        )}
                      </Table.Column>
                    );
                  })}
                </Table.Header>

                <Table.Body
                  items={bodyItems}
                  renderEmptyState={() =>
                    loading ? (
                      <div
                        role="status"
                        className="grid min-h-40 w-full max-w-[28rem] place-content-center content-center justify-items-stretch gap-2 p-8 text-sm text-ink-muted"
                      >
                        <span
                          aria-hidden="true"
                          className="h-3 w-full rounded-sm bg-surface-sunken"
                        />
                        <span
                          aria-hidden="true"
                          className="h-3 w-4/5 rounded-sm bg-surface-sunken"
                        />
                        <span
                          aria-hidden="true"
                          className="h-3 w-3/5 rounded-sm bg-surface-sunken"
                        />
                        <span className="mt-2 justify-self-center">
                          Loading rows
                        </span>
                      </div>
                    ) : (
                      <div className="grid min-h-40 place-content-center justify-items-center gap-2 p-8 text-center text-ink-muted">
                        {emptyIcon ?? (
                          <span
                            aria-hidden="true"
                            className="brand-mark size-9 text-primary"
                          />
                        )}
                        <strong className="text-ink">{emptyTitle}</strong>
                        {emptyDescription ? (
                          <span className="text-sm">{emptyDescription}</span>
                        ) : null}
                        {emptyActions ? (
                          <div className="mt-4 flex flex-wrap justify-center gap-2">
                            {emptyActions}
                          </div>
                        ) : null}
                      </div>
                    )
                  }
                >
                  {(row) => {
                    const cellById = new Map(
                      row
                        .getVisibleCells()
                        .map((cell) => [cell.column.id, cell] as const),
                    );
                    return (
                      <Table.Row
                        id={row.id}
                        columns={leafHeaders}
                        className="odd:bg-surface-sunken/40"
                      >
                        {(header) => {
                          const cell = cellById.get(header.column.id);
                          const align = header.column.columnDef.meta?.align;
                          return (
                            <Table.Cell
                              className={clsx(
                                "px-4 py-3 align-middle",
                                alignClass(align),
                              )}
                            >
                              {cell
                                ? flexRender(
                                    cell.column.columnDef.cell,
                                    cell.getContext(),
                                  )
                                : null}
                            </Table.Cell>
                          );
                        }}
                      </Table.Row>
                    );
                  }}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>

          {showFooter ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-5 py-3">
              <div className="flex items-center gap-2">
                <span className="text-[0.7rem] font-extrabold tracking-[0.08em] text-ink-muted uppercase">
                  Rows
                </span>
                <Select
                  aria-label="Rows per page"
                  selectedKey={pagination.pageSize}
                  onSelectionChange={(key) => {
                    if (key !== null) {
                      setPagination({ pageIndex: 0, pageSize: Number(key) });
                    }
                  }}
                >
                  <Select.Trigger className="min-w-[4.5rem]">
                    <Select.Value />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {rowsPerPageOptions.map((size) => (
                        <ListBox.Item
                          key={size}
                          id={size}
                          textValue={String(size)}
                        >
                          {size}
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              </div>

              {pageCount > 1 ? (
                <Pagination aria-label={`${title} pagination`}>
                  <Pagination.Content className="flex items-center gap-1">
                    <Pagination.Item>
                      <Pagination.Previous
                        aria-label="Previous page"
                        isDisabled={!table.getCanPreviousPage()}
                        onPress={() => table.previousPage()}
                      >
                        <ChevronLeft aria-hidden="true" className="size-4" />
                      </Pagination.Previous>
                    </Pagination.Item>
                    {pageItems.map((item) =>
                      typeof item === "number" ? (
                        <Pagination.Item key={item}>
                          <Pagination.Link
                            isActive={item === currentPage}
                            aria-label={`Page ${item}`}
                            onPress={() => table.setPageIndex(item - 1)}
                          >
                            {item}
                          </Pagination.Link>
                        </Pagination.Item>
                      ) : (
                        <Pagination.Item key={item}>
                          <Pagination.Ellipsis />
                        </Pagination.Item>
                      ),
                    )}
                    <Pagination.Item>
                      <Pagination.Next
                        aria-label="Next page"
                        isDisabled={!table.getCanNextPage()}
                        onPress={() => table.nextPage()}
                      >
                        <ChevronRight aria-hidden="true" className="size-4" />
                      </Pagination.Next>
                    </Pagination.Item>
                  </Pagination.Content>
                </Pagination>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
