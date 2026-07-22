<script setup lang="ts">
useSeoMeta({
  title: "Privacy notice",
  description:
    "Review the non-production scaffold for the Join The Six privacy notice.",
  robots: "noindex, nofollow",
});
</script>

<template>
  <article class="public-page policy-page">
    <div class="container policy-content">
      <JtsPageHeader
        variant="policy"
        eyebrow="Policy scaffold"
        title="Privacy notice"
        description="A readable structure for the final notice—not fabricated legal copy wearing a confident tie."
      />

      <div class="policy-notice" role="note">
        <span class="pi pi-exclamation-triangle" aria-hidden="true" />
        <p>
          This notice is not ready for production. Counsel must confirm the
          controller, purposes, retention periods, lawful bases and participant
          rights before publication.
        </p>
      </div>

      <div class="surface-card policy-body">
        <section aria-labelledby="privacy-information">
          <h2 id="privacy-information">
            Information this product expects to process
          </h2>
          <p>
            Contact details, dinner registration information, operational
            attendance data and payment references. Sensitive information must
            not be collected without a documented purpose and retention rule.
          </p>
        </section>
        <section aria-labelledby="privacy-rights">
          <h2 id="privacy-rights">Your rights and contact details</h2>
          <p>
            The final notice must identify the correct contact channel and
            explain access, correction, deletion and objection rights in plain
            language.
          </p>
        </section>
      </div>
    </div>
  </article>
</template>
