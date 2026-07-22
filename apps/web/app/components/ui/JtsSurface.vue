<script setup lang="ts">
type SurfaceTone = "blush" | "burgundy";
type SurfacePadding = "normal" | "roomy";

withDefaults(
  defineProps<{
    tone?: SurfaceTone | null;
    padding?: SurfacePadding;
    eyebrow?: string | null;
    title: string;
    description?: string | null;
  }>(),
  {
    tone: null,
    padding: "normal",
    eyebrow: null,
    description: null,
  },
);

defineSlots<{
  default?: () => unknown;
  actions?: () => unknown;
  footer?: () => unknown;
}>();

const headingId = useId();
</script>

<template>
  <section
    class="jts-surface"
    :class="[
      tone ? `jts-surface--${tone}` : undefined,
      `jts-surface--padding-${padding}`,
    ]"
    :aria-labelledby="headingId"
  >
    <header class="jts-surface__header">
      <div class="jts-surface__heading">
        <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
        <h2 :id="headingId" class="jts-surface__title">{{ title }}</h2>
        <p v-if="description" class="jts-surface__description">
          {{ description }}
        </p>
      </div>
      <div v-if="$slots.actions" class="jts-surface__actions">
        <slot name="actions" />
      </div>
    </header>
    <div class="jts-surface__content">
      <slot />
    </div>
    <footer v-if="$slots.footer" class="jts-surface__footer">
      <slot name="footer" />
    </footer>
  </section>
</template>
