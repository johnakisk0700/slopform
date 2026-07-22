<script setup lang="ts">
useSeoMeta({
  title: "Request a seat",
  description:
    "Request a seat at a Join The Six dinner and share the details needed to plan your place.",
  robots: "noindex, nofollow",
});
</script>

<template>
  <section class="public-page registration-page">
    <div class="container public-stack">
      <JtsPageHeader
        eyebrow="Dinner registration"
        title="Tell us enough to plan your seat."
        description="We ask only for the information needed to contact you and prepare the dinner."
      />

      <div class="registration-layout">
        <RegistrationForm />

        <aside class="registration-aside" aria-label="Registration context">
          <JtsSurface
            tone="blush"
            eyebrow="Preview event"
            title="Foundation dinner"
            description="Date, location and price are intentionally omitted until live event data is available."
          >
            <ul class="trust-list">
              <li>
                <span class="pi pi-lock" aria-hidden="true" />
                <span>This preview does not store or submit your details.</span>
              </li>
              <li>
                <span class="pi pi-eye-slash" aria-hidden="true" />
                <span>Do not include sensitive medical information.</span>
              </li>
              <li>
                <span class="pi pi-info-circle" aria-hidden="true" />
                <span>A request is not a confirmed seat.</span>
              </li>
            </ul>
          </JtsSurface>
        </aside>
      </div>
    </div>
  </section>
</template>
