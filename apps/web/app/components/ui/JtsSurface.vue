<script setup lang="ts">
type SurfaceTag = "section" | "article" | "aside" | "div";
type SurfaceTone = "default" | "cream" | "blush" | "burgundy";
type SurfacePadding = "none" | "compact" | "normal" | "roomy";
type SurfaceHeadingTag = "h2" | "h3";

withDefaults(
  defineProps<{
    as?: SurfaceTag;
    tone?: SurfaceTone;
    padding?: SurfacePadding;
    eyebrow?: string | null;
    title: string;
    description?: string | null;
    headingTag?: SurfaceHeadingTag;
  }>(),
  {
    as: "section",
    tone: "default",
    padding: "normal",
    eyebrow: null,
    description: null,
    headingTag: "h2",
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
  <component
    :is="as"
    class="jts-surface"
    :class="[`jts-surface--${tone}`, `jts-surface--padding-${padding}`]"
    :aria-labelledby="headingId"
  >
    <header class="jts-surface__header">
      <div class="jts-surface__heading">
        <p v-if="eyebrow" class="eyebrow">{{ eyebrow }}</p>
        <component :is="headingTag" :id="headingId" class="jts-surface__title">
          {{ title }}
        </component>
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
  </component>
</template>
