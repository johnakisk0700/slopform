<script setup lang="ts">
useSeoMeta({ title: "Join a dinner" });
</script>

<template>
  <section class="public-page">
    <div class="container">
      <div class="public-page__header">
        <p class="eyebrow">Join The Six</p>
        <h1 class="public-page__title">Meet five people worth talking to.</h1>
        <p class="lede">
          This route is server rendered. Interactive event discovery can be
          added here without turning the policy pages or first response into a
          client-only shell.
        </p>
      </div>
      <div class="surface-card form-card">
        <h2>Foundation dinner</h2>
        <p>
          Example route only — real availability will come from the Nest API.
        </p>
        <Button
          as="router-link"
          label="Request a seat"
          to="/register/foundation-dinner"
        />
      </div>
    </div>
  </section>
</template>
