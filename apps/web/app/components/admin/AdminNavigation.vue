<script setup lang="ts">
defineEmits<{
  navigate: [];
}>();

const route = useRoute();

const items = [
  { label: "Overview", icon: "pi pi-th-large", route: "/admin" },
  { label: "Participants", icon: "pi pi-users", disabled: true },
  { label: "Events", icon: "pi pi-calendar", disabled: true },
  { label: "Payments", icon: "pi pi-credit-card", disabled: true },
];
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
        <span :class="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
      </NuxtLink>
      <span v-else class="admin-nav-link" aria-disabled="true">
        <span :class="item.icon" aria-hidden="true" />
        <span>{{ item.label }}</span>
        <small>Soon</small>
      </span>
    </template>
  </PanelMenu>
</template>
