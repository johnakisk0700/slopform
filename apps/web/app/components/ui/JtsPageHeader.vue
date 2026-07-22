<script setup lang="ts">
withDefaults(
  defineProps<{
    eyebrow?: string | null;
    title: string;
    description?: string | null;
  }>(),
  {
    eyebrow: null,
    description: null,
  },
);

defineSlots<{
  actions?: () => unknown;
}>();
</script>

<template>
  <header class="jts-page-header">
    <div class="jts-page-header__copy">
      <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
      <h1 class="jts-page-header__title">{{ title }}</h1>
      <p v-if="description" class="jts-page-header__description">
        {{ description }}
      </p>
      <div v-if="$slots.actions" class="jts-page-header__actions">
        <slot name="actions" />
      </div>
    </div>
  </header>
</template>
