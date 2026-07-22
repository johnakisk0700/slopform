<script setup lang="ts">
import JtsPageHeader from "~/components/ui/JtsPageHeader.vue";
import JtsSurface from "~/components/ui/JtsSurface.vue";

useSeoMeta({
  title: "Join a dinner",
  description: "Find a Join The Six dinner and request a seat.",
});
</script>

<template>
  <section class="public-page join-page">
    <div class="container public-stack">
      <JtsPageHeader
        eyebrow="Join a dinner"
        title="Meet five people worth talking to."
        description="Live dinner dates and seat availability are not connected yet. This preview shows the shape of the journey without pretending a placeholder is a booking."
      >
        <template #aside>
          <div class="mini-table-art" aria-hidden="true">
            <span />
            <span />
            <span />
            <span />
            <span />
            <span />
          </div>
        </template>
      </JtsPageHeader>

      <JtsSurface
        class="event-preview"
        tone="default"
        padding="roomy"
        eyebrow="Preview listing"
        title="Foundation dinner"
        description="A representative event card for validating the registration route."
      >
        <dl class="event-facts">
          <div>
            <dt>Date</dt>
            <dd>To be confirmed</dd>
          </div>
          <div>
            <dt>Area</dt>
            <dd>To be confirmed</dd>
          </div>
          <div>
            <dt>Availability</dt>
            <dd><span class="preview-pill">Preview only</span></dd>
          </div>
        </dl>
        <template #footer>
          <div class="event-preview__footer">
            <p>
              Opening this form does not reserve a real seat while the events
              API is disconnected.
            </p>
            <Button
              as="router-link"
              label="View registration preview"
              to="/register/foundation-dinner"
              icon="pi pi-arrow-right"
              icon-pos="right"
            />
          </div>
        </template>
      </JtsSurface>

      <section class="public-note" aria-labelledby="public-note-title">
        <p class="eyebrow">What happens next</p>
        <h2 id="public-note-title">Only the information the dinner needs.</h2>
        <p>
          The registration form asks for contact details, a dietary preference
          and optional planning context. Final booking, payment and confirmation
          rules will be shown only after those contracts are agreed.
        </p>
      </section>
    </div>
  </section>
</template>
