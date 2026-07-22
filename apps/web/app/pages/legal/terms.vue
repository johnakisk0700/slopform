<script setup lang="ts">
import JtsPageHeader from "~/components/ui/JtsPageHeader.vue";

useSeoMeta({ title: "Terms of participation" });
</script>

<template>
  <article class="public-page policy-page">
    <div class="container policy-content">
      <JtsPageHeader
        variant="policy"
        eyebrow="Policy scaffold"
        title="Terms of participation"
        description="The future home for clear participation rules. It is not legal advice or a production agreement."
      />

      <div class="policy-notice" role="note">
        <span class="pi pi-exclamation-triangle" aria-hidden="true" />
        <p>
          Booking, cancellation, conduct and safety language must be reviewed
          and approved before these terms are published as final.
        </p>
      </div>

      <div class="surface-card policy-body">
        <section aria-labelledby="terms-booking">
          <h2 id="terms-booking">Bookings and payment</h2>
          <p>
            Define when a seat becomes confirmed, what happens after failed
            payment and how cancellations and refunds work before publishing
            this page.
          </p>
        </section>
        <section aria-labelledby="terms-safety">
          <h2 id="terms-safety">Conduct and safety</h2>
          <p>
            The final terms should set clear behavioral expectations and provide
            a private escalation route for participant concerns.
          </p>
        </section>
      </div>
    </div>
  </article>
</template>
