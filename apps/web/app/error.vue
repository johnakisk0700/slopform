<script setup lang="ts">
import type { NuxtError } from "#app";

defineProps<{
  error: NuxtError;
}>();
</script>

<template>
  <main id="main-content" class="public-page">
    <div class="container policy-content">
      <p class="eyebrow">Something went wrong</p>
      <h1 class="public-page__title">We could not open this page.</h1>
      <p class="lede">
        Error {{ error.statusCode }}. Try again or return home.
      </p>
      <Button label="Return home" @click="clearError({ redirect: '/' })" />
    </div>
  </main>
</template>
