<script setup lang="ts">
useSeoMeta({
  title: "Dinner feedback",
  robots: "noindex, nofollow",
});
</script>

<template>
  <section class="public-page feedback-page">
    <div class="container public-stack public-stack--narrow">
      <JtsPageHeader
        eyebrow="Private feedback"
        title="How did the dinner feel?"
        description="This private route is ready for a feedback contract, but the form stays closed until token expiry and replay rules are defined."
      />

      <JtsSurface
        tone="blush"
        padding="roomy"
        title="Feedback is not connected yet"
        description="No response can be submitted from this preview route."
      >
        <div class="feedback-placeholder">
          <span class="pi pi-comments" aria-hidden="true" />
          <p>
            When the backend contract is ready, this surface will distinguish a
            valid invitation from expired or already-used links and show a clear
            recovery path.
          </p>
        </div>
      </JtsSurface>
    </div>
  </section>
</template>
