<script setup lang="ts">
import JtsPageHeader from "~/components/ui/JtsPageHeader.vue";
import JtsSurface from "~/components/ui/JtsSurface.vue";

const route = useRoute();
const eventSlug = computed(() => String(route.params.eventSlug));

useSeoMeta({
  title: "Request a seat",
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
        <PublicRegistrationForm :event-slug="eventSlug" />

        <aside class="registration-aside" aria-label="Registration context">
          <JtsSurface
            as="div"
            tone="blush"
            padding="normal"
            eyebrow="Preview event"
            title="Foundation dinner"
            description="Date, location and price are intentionally omitted until live event data is available."
          >
            <ul class="trust-list">
              <li>
                <span class="pi pi-lock" aria-hidden="true" />
                <span>Your details are submitted to the application API.</span>
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
