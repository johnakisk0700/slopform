<script setup lang="ts">
import { motion } from "motion-v";
import Button from "primevue/button";
import Card from "primevue/card";
import Column from "primevue/column";
import DatePicker from "primevue/datepicker";
import Dialog from "primevue/dialog";
import InputText from "primevue/inputtext";
import ProgressBar from "primevue/progressbar";
import Tag from "primevue/tag";
import { useToast } from "primevue/usetoast";
import {
  eventPreviewSchema,
  getEventPreviewErrors,
  type EventPreviewDraft,
} from "~/features/event/schema";

definePageMeta({ layout: "admin" });
useSeoMeta({
  title: "Operations control",
  description: "Private Join The Six event operations workspace.",
  robots: "noindex, nofollow",
});

interface EventPreview {
  id: string;
  name: string;
  city: string;
  date: string;
  bookings: number;
  capacity: number;
  blockers: number;
  status: "Draft" | "Open" | "Ready";
}

const previewRows = ref<EventPreview[]>([
  {
    id: "preview-1",
    name: "Foundation dinner",
    city: "Athens",
    date: "2026-08-06",
    bookings: 18,
    capacity: 24,
    blockers: 2,
    status: "Open",
  },
  {
    id: "preview-2",
    name: "September dinner",
    city: "Athens",
    date: "2026-09-10",
    bookings: 0,
    capacity: 30,
    blockers: 1,
    status: "Draft",
  },
  {
    id: "preview-3",
    name: "Community table",
    city: "Athens",
    date: "2026-07-30",
    bookings: 22,
    capacity: 24,
    blockers: 0,
    status: "Ready",
  },
]);

const toast = useToast();
const dialogOpen = ref(false);
const draft = reactive<EventPreviewDraft>({
  name: "",
  date: null,
});
const formErrors = ref<{ name?: string; date?: string }>({});

const totalPreviewBookings = computed(() =>
  previewRows.value.reduce((total, event) => total + event.bookings, 0),
);
const activePreviewEvents = computed(
  () => previewRows.value.filter((event) => event.status !== "Draft").length,
);
const openBlockers = computed(() =>
  previewRows.value.reduce((total, event) => total + event.blockers, 0),
);
const nextDinner = computed(() => previewRows.value[0]);

const dateFormatter = new Intl.DateTimeFormat("en-GB", {
  day: "2-digit",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

function formatDate(value: string): string {
  return dateFormatter.format(new Date(`${value}T00:00:00Z`));
}

function occupancy(event: EventPreview): number {
  return Math.round((event.bookings / event.capacity) * 100);
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
      city: "Athens",
      date: result.data.date.toISOString().slice(0, 10),
      bookings: 0,
      capacity: 24,
      blockers: 1,
      status: "Draft",
    },
  ];
  dialogOpen.value = false;
  toast.add({
    severity: "success",
    summary: "Preview event created",
    detail: "Local UI state only; the events API is not connected yet.",
    life: 5_000,
  });
}

function statusSeverity(status: EventPreview["status"]) {
  return status === "Ready" ? "success" : status === "Open" ? "info" : "warn";
}
</script>

<template>
  <motion.section
    class="admin-page-stack"
    :initial="{ opacity: 0, y: 8 }"
    :animate="{ opacity: 1, y: 0 }"
    :transition="{ duration: 0.2 }"
  >
    <JtsPageHeader
      eyebrow="Admin workspace"
      title="Operations control"
      description="Events, bookings and blockers in one focused workspace for the team running Join The Six."
    >
      <template #actions>
        <Button icon="pi pi-plus" label="New event" @click="openDialog" />
      </template>
    </JtsPageHeader>

    <div class="admin-preview-note" role="note">
      <span class="pi pi-info-circle" aria-hidden="true" />
      <span>
        Local product preview. The layout and interactions are real; the values
        reset on reload until the operations API is connected.
      </span>
    </div>

    <dl class="admin-stats" aria-label="Operations summary">
      <JtsStat
        label="Active events"
        :value="activePreviewEvents"
        detail="Open or ready"
      >
        <template #icon><span class="pi pi-calendar" /></template>
      </JtsStat>
      <JtsStat
        label="Bookings"
        :value="totalPreviewBookings"
        detail="Across preview events"
      >
        <template #icon><span class="pi pi-ticket" /></template>
      </JtsStat>
      <JtsStat
        label="Open blockers"
        :value="openBlockers"
        detail="Need operator action"
        tone="warning"
      >
        <template #icon><span class="pi pi-exclamation-triangle" /></template>
      </JtsStat>
      <JtsStat
        label="Ready events"
        :value="previewRows.filter((event) => event.status === 'Ready').length"
        detail="Cleared to run"
        tone="success"
      >
        <template #icon><span class="pi pi-check-circle" /></template>
      </JtsStat>
    </dl>

    <section class="admin-focus-grid" aria-label="Operational focus">
      <Card class="admin-focus-card admin-focus-card--primary">
        <template #title>Next dinner</template>
        <template #subtitle>Immediate event context</template>
        <template #content>
          <div v-if="nextDinner" class="next-event">
            <div class="next-event__heading">
              <div>
                <strong>{{ nextDinner.name }}</strong>
                <span
                  >{{ nextDinner.city }} ·
                  {{ formatDate(nextDinner.date) }}</span
                >
              </div>
              <Tag
                :value="nextDinner.status"
                :severity="statusSeverity(nextDinner.status)"
              />
            </div>
            <div class="next-event__capacity">
              <div>
                <span>Table capacity</span>
                <strong
                  >{{ nextDinner.bookings }} / {{ nextDinner.capacity }}</strong
                >
              </div>
              <ProgressBar :value="occupancy(nextDinner)" :show-value="false" />
            </div>
          </div>
        </template>
      </Card>

      <Card class="admin-focus-card">
        <template #title>Needs attention</template>
        <template #subtitle>Operator queue</template>
        <template #content>
          <ul class="attention-list">
            <li>
              <span
                class="attention-list__icon pi pi-map-marker"
                aria-hidden="true"
              />
              <span
                ><strong>Confirm venue</strong
                ><small>Foundation dinner</small></span
              >
              <Tag value="Today" severity="danger" />
            </li>
            <li>
              <span
                class="attention-list__icon pi pi-credit-card"
                aria-hidden="true"
              />
              <span
                ><strong>Review two payments</strong
                ><small>Missing references</small></span
              >
              <Tag value="2" severity="warn" />
            </li>
            <li>
              <span
                class="attention-list__icon pi pi-sitemap"
                aria-hidden="true"
              />
              <span
                ><strong>Lock table plan</strong
                ><small>Community table</small></span
              >
              <Tag value="Ready" severity="success" />
            </li>
          </ul>
        </template>
      </Card>
    </section>

    <JtsDataTable
      :rows="previewRows"
      data-key="id"
      title="Event operations"
      description="Current event stage, capacity and unresolved blockers."
      empty-title="No events yet"
      empty-description="Create the first event to start the operational workflow."
      paginator
      :page-size="5"
      :rows-per-page-options="[5, 10, 25]"
    >
      <template #toolbar-end>
        <Button
          icon="pi pi-filter"
          label="Filters"
          severity="secondary"
          outlined
          disabled
        />
      </template>
      <Column field="name" header="Event" sortable>
        <template #body="{ data }: { data: EventPreview }">
          <div class="admin-event-name">
            <strong>{{ data.name }}</strong>
            <small>{{ data.city }}</small>
          </div>
        </template>
      </Column>
      <Column field="date" header="Date" sortable>
        <template #body="{ data }: { data: EventPreview }">
          <time :datetime="data.date">{{ formatDate(data.date) }}</time>
        </template>
      </Column>
      <Column field="bookings" header="Bookings" sortable>
        <template #body="{ data }: { data: EventPreview }">
          {{ data.bookings }} / {{ data.capacity }}
        </template>
      </Column>
      <Column field="blockers" header="Blockers" sortable>
        <template #body="{ data }: { data: EventPreview }">
          <Tag
            :value="data.blockers ? String(data.blockers) : 'Clear'"
            :severity="data.blockers ? 'warn' : 'success'"
          />
        </template>
      </Column>
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
          <span>This adds local UI state only and does not call an API.</span>
        </div>
        <div class="field">
          <label for="event-name">Event name <span>Required</span></label>
          <InputText
            id="event-name"
            v-model="draft.name"
            required
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
          <label for="event-date">Dinner date <span>Required</span></label>
          <DatePicker
            v-model="draft.date"
            input-id="event-date"
            required
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
        <Button type="submit" form="event-preview-form" label="Create event" />
      </template>
    </Dialog>
  </motion.section>
</template>
