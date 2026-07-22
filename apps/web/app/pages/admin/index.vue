<script setup lang="ts">
import { motion } from "motion-v";
import { useToast } from "primevue/usetoast";
import * as z from "zod";

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

const eventSchema = z.object({
  name: z.string().trim().min(3, "Use at least three characters."),
  date: z.date({ error: "Choose a date." }),
});

const toast = useToast();
const dialogOpen = ref(false);
const draft = reactive<{ name: string; date: Date | null }>({
  name: "",
  date: null,
});
const formErrors = ref<{ name?: string; date?: string }>({});

function openDialog(): void {
  draft.name = "";
  draft.date = null;
  formErrors.value = {};
  dialogOpen.value = true;
}

function createPreviewEvent(): void {
  const result = eventSchema.safeParse(draft);

  if (!result.success) {
    formErrors.value = result.error.issues.reduce<{
      name?: string;
      date?: string;
    }>((errors, issue) => {
      const field = issue.path[0];
      if (field === "name" || field === "date") {
        errors[field] ??= issue.message;
      }
      return errors;
    }, {});
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
    :initial="{ opacity: 0, y: 10 }"
    :animate="{ opacity: 1, y: 0 }"
    :transition="{ duration: 0.22 }"
  >
    <header class="admin-page-header">
      <div>
        <p class="eyebrow">Admin foundation</p>
        <h1>Operations overview</h1>
        <p>
          PrimeVue interaction patterns using clearly labelled preview data.
        </p>
      </div>
      <Button icon="pi pi-plus" label="New preview event" @click="openDialog" />
    </header>

    <section
      class="surface-card admin-card"
      aria-labelledby="events-table-title"
    >
      <Toolbar>
        <template #start>
          <div>
            <h2 id="events-table-title">Event table pattern</h2>
            <span class="field-help"
              >In-memory preview data; no backend claim.</span
            >
          </div>
        </template>
        <template #end>
          <Button
            icon="pi pi-refresh"
            label="Refresh"
            severity="secondary"
            disabled
          />
        </template>
      </Toolbar>

      <DataTable
        :value="previewRows"
        data-key="id"
        striped-rows
        responsive-layout="scroll"
        aria-label="Preview events"
      >
        <Column field="name" header="Event" />
        <Column field="date" header="Date" />
        <Column field="registrations" header="Registrations" />
        <Column field="status" header="Status">
          <template #body="{ data }: { data: EventPreview }">
            <Tag :value="data.status" :severity="statusSeverity(data.status)" />
          </template>
        </Column>
        <template #empty>No preview events yet.</template>
      </DataTable>
    </section>

    <Dialog
      v-model:visible="dialogOpen"
      modal
      header="Create a preview event"
      :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
    >
      <form
        id="event-preview-form"
        class="form-grid"
        @submit.prevent="createPreviewEvent"
      >
        <Message severity="info" :closable="false">
          This demonstrates form, dialog and toast behavior. It does not
          persist.
        </Message>
        <div class="field">
          <label for="event-name">Event name</label>
          <InputText
            id="event-name"
            v-model="draft.name"
            autofocus
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
            :aria-describedby="formErrors.date ? 'event-date-error' : undefined"
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
