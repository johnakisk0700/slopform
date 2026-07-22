<script setup lang="ts">
useHead({
  titleTemplate: (title) =>
    title ? `${title} · Join The Six` : "Join The Six",
});
</script>

<template>
  <NuxtRouteAnnouncer />
  <NuxtLoadingIndicator color="var(--jts-color-primary)" />
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <NuxtLayout>
    <NuxtPage />
  </NuxtLayout>
</template>
