<script setup lang="ts" generic="T extends object">
import DataTable from "primevue/datatable";
import Toolbar from "primevue/toolbar";

const props = withDefaults(
  defineProps<{
    rows: readonly T[];
    title: string;
    description?: string | null;
    dataKey: keyof T & string;
    loading?: boolean;
    error?: string | null;
    emptyTitle?: string;
    emptyDescription?: string;
    paginator?: boolean;
    pageSize?: number;
    rowsPerPageOptions?: number[];
  }>(),
  {
    description: null,
    loading: false,
    error: null,
    emptyTitle: "Nothing to show yet",
    emptyDescription: "Rows will appear here when they are available.",
    paginator: false,
    pageSize: 10,
    rowsPerPageOptions: () => [10, 25, 50],
  },
);

defineSlots<{
  default: () => unknown;
  "toolbar-end"?: () => unknown;
  "empty-actions"?: () => unknown;
  "error-actions"?: () => unknown;
}>();

const titleId = useId();
const descriptionId = useId();
const tableProperties = computed(() => ({
  "aria-labelledby": titleId,
  "aria-describedby": props.description ? descriptionId : undefined,
  "aria-busy": props.loading ? ("true" as const) : undefined,
}));
const dataTablePassThrough = computed(() => ({
  tableContainer: {
    role: "region",
    tabindex: 0,
    "aria-labelledby": titleId,
  },
  pcPaginator: {
    paginatorContainer: {
      "aria-label": `${props.title} pagination`,
    },
  },
}));
</script>

<template>
  <section class="jts-data-table" :aria-labelledby="titleId">
    <Toolbar class="jts-data-table__toolbar">
      <template #start>
        <div class="jts-data-table__heading">
          <h2 :id="titleId" class="jts-data-table__title">{{ title }}</h2>
          <p
            v-if="description"
            :id="descriptionId"
            class="jts-data-table__description"
          >
            {{ description }}
          </p>
        </div>
      </template>
      <template v-if="$slots['toolbar-end']" #end>
        <div class="jts-data-table__actions">
          <slot name="toolbar-end" />
        </div>
      </template>
    </Toolbar>

    <div
      v-if="error && !loading"
      class="jts-data-table__state"
      :class="{ 'jts-data-table__state--inline': rows.length > 0 }"
      role="alert"
    >
      <span class="pi pi-exclamation-circle" aria-hidden="true" />
      <div>
        <h3>Could not load this table</h3>
        <p>{{ error }}</p>
        <div
          v-if="$slots['error-actions']"
          class="jts-data-table__state-actions"
        >
          <slot name="error-actions" />
        </div>
      </div>
    </div>

    <div
      v-if="loading || !error || rows.length > 0"
      class="jts-data-table__table"
    >
      <DataTable
        :value="rows"
        :data-key="dataKey"
        :loading="loading"
        :paginator="paginator && rows.length > 0"
        :rows="pageSize"
        :rows-per-page-options="rowsPerPageOptions"
        :always-show-paginator="false"
        paginator-template="RowsPerPageDropdown FirstPageLink PrevPageLink CurrentPageReport NextPageLink LastPageLink"
        current-page-report-template="{first}–{last} of {totalRecords}"
        striped-rows
        :table-style="{ minWidth: '44rem' }"
        :table-props="tableProperties"
        :pt="dataTablePassThrough"
      >
        <slot />
        <template #loading>
          <div class="jts-data-table__loading" role="status">
            <span class="jts-data-table__spinner" aria-hidden="true" />
            <span>Loading rows</span>
          </div>
        </template>
        <template #empty>
          <div v-if="!loading" class="jts-data-table__empty">
            <span class="brand__mark" aria-hidden="true" />
            <strong>{{ emptyTitle }}</strong>
            <span>{{ emptyDescription }}</span>
            <div
              v-if="$slots['empty-actions']"
              class="jts-data-table__state-actions"
            >
              <slot name="empty-actions" />
            </div>
          </div>
        </template>
      </DataTable>
    </div>
  </section>
</template>
