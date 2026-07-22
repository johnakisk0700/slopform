<script setup lang="ts">
import type { NuxtError } from "#app";

const props = defineProps<{
  error: NuxtError;
}>();

const isNotFound = computed(() => props.error.statusCode === 404);
const title = computed(() =>
  isNotFound.value ? "Page not found" : "Page unavailable",
);
const description = computed(() =>
  isNotFound.value
    ? "The requested admin page could not be found."
    : "The Join The Six admin panel is temporarily unavailable.",
);

useSeoMeta({
  title: () => `${title.value} · Join The Six`,
  description: () => description.value,
  robots: "noindex, nofollow",
});
</script>

<template>
  <div class="error-shell">
    <a class="skip-link" href="#main-content">Skip to main content</a>
    <header class="error-shell__header">
      <a class="brand" href="/admin" aria-label="Join The Six admin home">
        <span class="brand__mark" aria-hidden="true" />
        <span>Join The Six</span>
      </a>
    </header>
    <main id="main-content" class="error-page" tabindex="-1">
      <div class="error-page__code" aria-hidden="true">
        {{ error.statusCode }}
      </div>
      <p class="eyebrow">
        {{ isNotFound ? "Unknown route" : "A brief pause" }}
      </p>
      <h1>
        {{
          isNotFound
            ? "This admin page does not exist."
            : "We could not open the admin panel."
        }}
      </h1>
      <p>
        {{
          isNotFound
            ? "The address may have changed, or the link may be incomplete."
            : "Try again in a moment or return to the control center."
        }}
      </p>
      <a class="error-page__action" href="/admin">Return to control center</a>
    </main>
  </div>
</template>
