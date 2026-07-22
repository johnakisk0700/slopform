<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{
  error: NuxtError;
}>();

const isNotFound = computed(() => props.error.statusCode === 404);
</script>

<template>
  <div class="error-shell">
    <header class="error-shell__header">
      <a class="brand" href="/" aria-label="Join The Six home">
        <span class="brand__mark" aria-hidden="true" />
        <span>Join The Six</span>
      </a>
    </header>
    <main id="main-content" class="error-page">
      <div class="error-page__code" aria-hidden="true">
        {{ error.statusCode }}
      </div>
      <p class="eyebrow">{{ isNotFound ? "Wrong table" : "A brief pause" }}</p>
      <h1>
        {{
          isNotFound
            ? "There is no page at this seat."
            : "We could not open this page."
        }}
      </h1>
      <p>
        {{
          isNotFound
            ? "The address may have changed, or the link may be incomplete."
            : "Try again in a moment or return to the home page."
        }}
      </p>
      <a class="error-page__action" href="/">Return home</a>
    </main>
  </div>
</template>
