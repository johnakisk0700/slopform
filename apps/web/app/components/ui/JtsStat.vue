<script setup lang="ts">
type StatTone = "success" | "warning";

withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    detail?: string | null;
    tone?: StatTone | null;
  }>(),
  {
    detail: null,
    tone: null,
  },
);

defineSlots<{
  icon?: () => unknown;
}>();
</script>

<template>
  <div class="jts-stat" :class="tone ? `jts-stat--${tone}` : undefined">
    <div v-if="$slots.icon" class="jts-stat__icon" aria-hidden="true">
      <slot name="icon" />
    </div>
    <dt class="jts-stat__label">{{ label }}</dt>
    <dd class="jts-stat__value">{{ value }}</dd>
    <dd v-if="detail" class="jts-stat__detail">{{ detail }}</dd>
  </div>
</template>
