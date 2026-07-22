# Frontend component inventory

Search this inventory before adding UI. Reuse a matching project contract; use
PrimeVue directly when none fits. Add a shared `Jts*` component only when it
owns repeated product behavior rather than renaming library props.

## Shared UI

| Component           | Contract                                   | Owns                                                                                        |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------- |
| `JtsPageHeader.vue` | [`jts-page-header.md`](jts-page-header.md) | One route title, supporting copy, actions and optional aside                                |
| `JtsSurface.vue`    | [`jts-surface.md`](jts-surface.md)         | Labelled content surface, established tones/density, actions and footer                     |
| `JtsStat.vue`       | [`jts-stat.md`](jts-stat.md)               | Definition-list-safe operational metric                                                     |
| `JtsDataTable.vue`  | [`jts-data-table.md`](jts-data-table.md)   | Accessible table title, loading/empty/error states, overflow, toolbar and client pagination |

## Domain components

| Component              | Owner        | Contract                                                        |
| ---------------------- | ------------ | --------------------------------------------------------------- |
| `AdminNavigation.vue`  | Admin shell  | Responsive navigation shared by sidebar and drawer              |
| `RegistrationForm.vue` | Registration | Preview fields and validation; [contract](registration-form.md) |

`JtsDataTable` owns table states and framing; the page owns columns, cell
formatting, filters, row actions and API calls. Add a prop or slot only after a
real consumer needs it. Update this inventory and the focused contract whenever
a reusable component changes.
