<script setup lang="ts">
type StatTone = "primary" | "neutral" | "success" | "warning";

withDefaults(
  defineProps<{
    label: string;
    value: string | number;
    detail?: string | null;
    tone?: StatTone;
  }>(),
  {
    detail: null,
    tone: "neutral",
  },
);

defineSlots<{
  icon?: () => unknown;
  detail?: () => unknown;
}>();
</script>

<template>
  <div class="jts-stat" :class="`jts-stat--${tone}`">
    <div v-if="$slots.icon" class="jts-stat__icon" aria-hidden="true">
      <slot name="icon" />
    </div>
    <div class="jts-stat__copy">
      <dt class="jts-stat__label">{{ label }}</dt>
      <dd class="jts-stat__value">{{ value }}</dd>
      <dd v-if="detail || $slots.detail" class="jts-stat__detail">
        <slot name="detail">{{ detail }}</slot>
      </dd>
    </div>
  </div>
</template>
