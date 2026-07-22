<script setup lang="ts">
type HeaderVariant = "public" | "admin" | "policy";
type HeaderAlign = "start" | "center";
type HeadingTag = "h1" | "h2";

withDefaults(
  defineProps<{
    eyebrow?: string | null;
    title: string;
    description?: string | null;
    variant?: HeaderVariant;
    align?: HeaderAlign;
    headingTag?: HeadingTag;
  }>(),
  {
    eyebrow: null,
    description: null,
    variant: "public",
    align: "start",
    headingTag: "h1",
  },
);

defineSlots<{
  default?: () => unknown;
  actions?: () => unknown;
  aside?: () => unknown;
}>();
</script>

<template>
  <header
    class="jts-page-header"
    :class="[
      `jts-page-header--${variant}`,
      `jts-page-header--${align}`,
      { 'jts-page-header--with-aside': $slots.aside },
    ]"
  >
    <div class="jts-page-header__copy">
      <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
      <component :is="headingTag" class="jts-page-header__title">
        {{ title }}
      </component>
      <p v-if="description" class="jts-page-header__description">
        {{ description }}
      </p>
      <slot />
      <div v-if="$slots.actions" class="jts-page-header__actions">
        <slot name="actions" />
      </div>
    </div>
    <div v-if="$slots.aside" class="jts-page-header__aside">
      <slot name="aside" />
    </div>
  </header>
</template>
