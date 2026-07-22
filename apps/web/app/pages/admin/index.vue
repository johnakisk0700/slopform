<script setup lang="ts">
import { motion } from "motion-v";
import { useToast } from "primevue/usetoast";
import {
  eventPreviewSchema,
  getEventPreviewErrors,
  type EventPreviewDraft,
} from "~/features/event/schema";

definePageMeta({ layout: "admin" });
useSeoMeta({ title: "Operations overview", robots: "noindex, nofollow" });

interface EventPreview {
  id: string;
  name: string;
  date: string;
  registrations: number;
  status: "Draft" | "Open" | "Closed";
}

const previewRows = ref<EventPreview[]>([
  {
    id: "preview-1",
    name: "Foundation dinner",
    date: "2026-08-06",
    registrations: 18,
    status: "Open",
  },
  {
    id: "preview-2",
    name: "September dinner",
    date: "2026-09-10",
    registrations: 0,
    status: "Draft",
  },
]);

const toast = useToast();
const dialogOpen = ref(false);
const draft = reactive<EventPreviewDraft>({
  name: "",
  date: null,
});
const formErrors = ref<{ name?: string; date?: string }>({});

const totalPreviewRegistrations = computed(() =>
  previewRows.value.reduce((total, event) => total + event.registrations, 0),
);
const openPreviewEvents = computed(
  () => previewRows.value.filter((event) => event.status === "Open").length,
);

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string): string {
  return dateFormatter.format(new Date(`${value}T00:00:00Z`));
}

function openDialog(): void {
  draft.name = "";
  draft.date = null;
  formErrors.value = {};
  dialogOpen.value = true;
}

async function focusFirstEventError(): Promise<void> {
  await nextTick();
  const id = formErrors.value.name ? "event-name" : "event-date";
  document.getElementById(id)?.focus();
}

async function createPreviewEvent(): Promise<void> {
  const result = eventPreviewSchema.safeParse(draft);

  if (!result.success) {
    formErrors.value = getEventPreviewErrors(draft);
    await focusFirstEventError();
    return;
  }

  previewRows.value = [
    ...previewRows.value,
    {
      id: crypto.randomUUID(),
      name: result.data.name,
      date: result.data.date.toISOString().slice(0, 10),
      registrations: 0,
      status: "Draft",
    },
  ];
  dialogOpen.value = false;
  toast.add({
    severity: "success",
    summary: "Preview row created",
    detail: "This is local UI state until the events API is connected.",
    life: 5_000,
  });
}

function statusSeverity(status: EventPreview["status"]) {
  return status === "Open"
    ? "success"
    : status === "Closed"
      ? "secondary"
      : "warn";
}
</script>

<template>
  <motion.section
    class="admin-overview"
    :initial="{ opacity: 0, y: 8 }"
    :animate="{ opacity: 1, y: 0 }"
    :transition="{ duration: 0.2 }"
  >
    <JtsPageHeader
      variant="admin"
      eyebrow="Preview workspace"
      title="Operations overview"
      description="A clear view of local event fixtures while the live operations contracts are connected."
    >
      <template #actions>
        <Button
          icon="pi pi-plus"
          label="New preview event"
          @click="openDialog"
        />
      </template>
    </JtsPageHeader>

    <div class="admin-preview-note" role="note">
      <span class="pi pi-info-circle" aria-hidden="true" />
      <span>
        Every number on this page comes from in-memory preview rows. Nothing
        here is a live operational metric.
      </span>
    </div>

    <dl class="admin-stats" aria-label="Preview event summary">
      <JtsStat
        label="Preview events"
        :value="previewRows.length"
        detail="Local fixture rows"
        tone="primary"
      >
        <template #icon><span class="pi pi-calendar" /></template>
      </JtsStat>
      <JtsStat
        label="Preview registrations"
        :value="totalPreviewRegistrations"
        detail="Sum of fixture values"
      >
        <template #icon><span class="pi pi-users" /></template>
      </JtsStat>
      <JtsStat
        label="Open previews"
        :value="openPreviewEvents"
        detail="Status labels, not availability"
        tone="success"
      >
        <template #icon><span class="pi pi-check-circle" /></template>
      </JtsStat>
      <JtsStat
        label="Data source"
        value="Preview fixtures"
        detail="Local edits reset on reload"
        tone="warning"
      >
        <template #icon><span class="pi pi-database" /></template>
      </JtsStat>
    </dl>

    <JtsDataTable
      :rows="previewRows"
      data-key="id"
      title="Event planning"
      description="In-memory preview rows for validating table, status and pagination behavior."
      empty-title="No preview events"
      empty-description="Create a local preview row to exercise the empty-to-ready transition."
      paginator
      :page-size="5"
      :rows-per-page-options="[5, 10, 25]"
    >
      <template #toolbar-end>
        <Button
          icon="pi pi-refresh"
          label="Refresh"
          severity="secondary"
          outlined
          disabled
        />
      </template>
      <Column field="name" header="Event" sortable>
        <template #body="{ data }: { data: EventPreview }">
          <strong class="admin-event-name">{{ data.name }}</strong>
        </template>
      </Column>
      <Column field="date" header="Date" sortable>
        <template #body="{ data }: { data: EventPreview }">
          <time :datetime="data.date">{{ formatDate(data.date) }}</time>
        </template>
      </Column>
      <Column field="registrations" header="Registrations" sortable />
      <Column field="status" header="Status" sortable>
        <template #body="{ data }: { data: EventPreview }">
          <Tag :value="data.status" :severity="statusSeverity(data.status)" />
        </template>
      </Column>
    </JtsDataTable>

    <Dialog
      v-model:visible="dialogOpen"
      modal
      header="Create a preview event"
      :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
    >
      <form
        id="event-preview-form"
        class="form-grid"
        novalidate
        @submit.prevent="createPreviewEvent"
      >
        <div class="dialog-note" role="note">
          <span class="pi pi-info-circle" aria-hidden="true" />
          <span>
            This adds local UI state only. It does not persist or call an events
            API.
          </span>
        </div>
        <div class="field">
          <label for="event-name">Event name</label>
          <InputText
            id="event-name"
            v-model="draft.name"
            autofocus
            autocomplete="off"
            :invalid="Boolean(formErrors.name)"
            :aria-describedby="formErrors.name ? 'event-name-error' : undefined"
          />
          <p v-if="formErrors.name" id="event-name-error" class="field-error">
            {{ formErrors.name }}
          </p>
        </div>
        <div class="field">
          <label for="event-date">Dinner date</label>
          <DatePicker
            v-model="draft.date"
            input-id="event-date"
            show-icon
            :invalid="Boolean(formErrors.date)"
            :pt="{
              pcInputText: {
                root: {
                  'aria-describedby': formErrors.date
                    ? 'event-date-error'
                    : undefined,
                },
              },
            }"
          />
          <p v-if="formErrors.date" id="event-date-error" class="field-error">
            {{ formErrors.date }}
          </p>
        </div>
      </form>
      <template #footer>
        <Button
          label="Cancel"
          severity="secondary"
          text
          @click="dialogOpen = false"
        />
        <Button
          type="submit"
          form="event-preview-form"
          label="Create preview row"
        />
      </template>
    </Dialog>
  </motion.section>
</template>
