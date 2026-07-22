<script setup lang="ts">
const route = useRoute();
const eventSlug = computed(() => String(route.params.eventSlug));

useSeoMeta({
  title: "Request a seat",
  robots: "noindex, nofollow",
});
</script>

<template>
  <section class="public-page">
    <div class="container">
      <div class="public-page__header">
        <p class="eyebrow">Dinner registration</p>
        <h1 class="public-page__title">Tell us enough to plan your seat.</h1>
        <p class="lede">
          We ask only for information needed to contact you and prepare the
          dinner.
        </p>
      </div>
      <PublicRegistrationForm :event-slug="eventSlug" />
    </div>
  </section>
</template>
