<script setup lang="ts">
type HeaderVariant = "public" | "admin" | "policy";

withDefaults(
  defineProps<{
    eyebrow?: string | null;
    title: string;
    description?: string | null;
    variant?: HeaderVariant;
  }>(),
  {
    eyebrow: null,
    description: null,
    variant: "public",
  },
);

defineSlots<{
  actions?: () => unknown;
  aside?: () => unknown;
}>();
</script>

<template>
  <header
    class="jts-page-header"
    :class="[
      `jts-page-header--${variant}`,
      { 'jts-page-header--with-aside': $slots.aside },
    ]"
  >
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
    <div v-if="$slots.aside" class="jts-page-header__aside">
      <slot name="aside" />
    </div>
  </header>
</template>
