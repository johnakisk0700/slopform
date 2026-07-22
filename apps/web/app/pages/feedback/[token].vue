<script setup lang="ts">
useSeoMeta({
  title: "Dinner feedback",
  robots: "noindex, nofollow",
});
</script>

<template>
  <section class="public-page">
    <div class="container">
      <div class="public-page__header">
        <p class="eyebrow">Private feedback</p>
        <h1 class="public-page__title">How did the dinner feel?</h1>
        <p class="lede">
          This SSR-capable token route is reserved for the real feedback
          contract. It intentionally does not invent fields before the product
          workflow is agreed.
        </p>
      </div>
      <Message severity="info" :closable="false">
        The feedback form will be connected after token expiry and replay rules
        are defined in the backend contract.
      </Message>
    </div>
  </section>
</template>
