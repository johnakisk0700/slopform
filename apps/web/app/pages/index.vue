<script setup lang="ts">
useSeoMeta({
  title: "Dinner conversations with intent",
});
</script>

<template>
  <section class="public-page">
    <div class="container">
      <div class="public-page__header">
        <p class="eyebrow">Product foundation</p>
        <h1 class="public-page__title">Small tables. Better conversations.</h1>
        <p class="lede">
          One Nuxt application serves the public journey and the operations
          workspace, while keeping their rendering and interaction budgets
          separate.
        </p>
      </div>
      <div class="home-grid">
        <article class="surface-card home-card">
          <h2>Public journey</h2>
          <p>SSR-ready event discovery, registration and feedback routes.</p>
          <Button as="router-link" label="Explore the public flow" to="/join" />
        </article>
        <article class="surface-card home-card">
          <h2>Operations</h2>
          <p>A client-rendered PrimeVue workspace for data-heavy admin work.</p>
          <Button
            as="router-link"
            label="Open the admin foundation"
            to="/admin"
            severity="secondary"
          />
        </article>
      </div>
    </div>
  </section>
</template>
