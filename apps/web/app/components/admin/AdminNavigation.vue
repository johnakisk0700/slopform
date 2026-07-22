<script setup lang="ts">
import PanelMenu from "primevue/panelmenu";

defineEmits<{
  navigate: [];
}>();

const route = useRoute();

const items = [
  { label: "Overview", icon: "pi pi-th-large", route: "/admin" },
  { label: "Events", icon: "pi pi-calendar", disabled: true },
  { label: "Participants", icon: "pi pi-users", disabled: true },
  { label: "Bookings", icon: "pi pi-ticket", disabled: true },
  { label: "Tables & matching", icon: "pi pi-sitemap", disabled: true },
  { label: "Payments", icon: "pi pi-credit-card", disabled: true },
  { label: "Communications", icon: "pi pi-send", disabled: true },
  { label: "Feedback & safety", icon: "pi pi-shield", disabled: true },
];

/** Print-index numeral ("01"…), decorative and hidden from AT. */
function navIndex(item: { label?: unknown }): string {
  return String(
    items.findIndex(({ label }) => label === item.label) + 1,
  ).padStart(2, "0");
}
</script>

<template>
  <PanelMenu :model="items">
    <template #item="{ item }">
      <NuxtLink
        v-if="item.route"
        class="admin-nav-link"
        :to="item.route"
        :aria-current="route.path === item.route ? 'page' : undefined"
        @click="$emit('navigate')"
      >
        <span class="admin-nav-link__index" aria-hidden="true">
          {{ navIndex(item) }}
        </span>
        <span :class="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </NuxtLink>
      <span v-else class="admin-nav-link" aria-disabled="true">
        <span class="admin-nav-link__index" aria-hidden="true">
          {{ navIndex(item) }}
        </span>
        <span :class="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
        <small>Soon</small>
      </span>
    </template>
  </PanelMenu>
</template>
