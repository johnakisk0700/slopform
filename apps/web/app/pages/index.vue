<script setup lang="ts">
import JtsPageHeader from "~/components/ui/JtsPageHeader.vue";
import JtsSurface from "~/components/ui/JtsSurface.vue";

useSeoMeta({
  title: "Dinner conversations with intent",
  description:
    "Join a small dinner table built around thoughtful conversation and six seats.",
});
</script>

<template>
  <section class="public-page home-page">
    <div class="container">
      <JtsPageHeader
        eyebrow="Dinner, kept human"
        title="Six seats. One good table."
        description="Join The Six is being built for people who would rather share a thoughtful dinner than work a room full of strangers."
      >
        <template #actions>
          <Button
            as="router-link"
            label="Find a dinner"
            icon="pi pi-arrow-right"
            icon-pos="right"
            to="/join"
          />
          <Button
            as="router-link"
            label="See the registration preview"
            to="/register/foundation-dinner"
            severity="secondary"
            outlined
          />
        </template>
        <template #aside>
          <div class="dinner-table-art" aria-hidden="true">
            <span class="dinner-table-art__plate" />
            <span class="dinner-table-art__seat dinner-table-art__seat--1" />
            <span class="dinner-table-art__seat dinner-table-art__seat--2" />
            <span class="dinner-table-art__seat dinner-table-art__seat--3" />
            <span class="dinner-table-art__seat dinner-table-art__seat--4" />
            <span class="dinner-table-art__seat dinner-table-art__seat--5" />
            <span class="dinner-table-art__seat dinner-table-art__seat--6" />
            <span class="dinner-table-art__note">A table for six</span>
          </div>
        </template>
      </JtsPageHeader>

      <section class="home-story" aria-labelledby="home-story-title">
        <div class="home-story__intro">
          <p class="eyebrow">A simple path in</p>
          <h2 id="home-story-title">Less networking. More conversation.</h2>
          <p>
            The current public journey is a transparent preview while live event
            availability and booking rules are connected.
          </p>
        </div>
        <ol class="journey-steps">
          <li>
            <span>01</span>
            <div>
              <strong>Choose a table</strong>
              <p>
                Browse real dinner details once the events API is connected.
              </p>
            </div>
          </li>
          <li>
            <span>02</span>
            <div>
              <strong>Share the essentials</strong>
              <p>
                Tell us how to contact you and what helps us plan your seat.
              </p>
            </div>
          </li>
          <li>
            <span>03</span>
            <div>
              <strong>Get clear next steps</strong>
              <p>
                Confirmation and payment rules will follow the final workflow.
              </p>
            </div>
          </li>
        </ol>
      </section>

      <div class="home-grid">
        <JtsSurface
          tone="blush"
          eyebrow="Public preview"
          title="Start with the dinner journey"
          description="See the warm, server-rendered route that will eventually hold live availability."
        >
          <template #actions>
            <Button
              as="router-link"
              label="Explore dinners"
              to="/join"
              text
              icon="pi pi-arrow-right"
              icon-pos="right"
            />
          </template>
        </JtsSurface>

        <JtsSurface
          tone="burgundy"
          eyebrow="Operations preview"
          title="A calm workspace behind the table"
          description="The admin route demonstrates local preview rows only. No live operations data is implied."
        >
          <template #actions>
            <Button
              as="router-link"
              label="Open operations"
              to="/admin"
              severity="secondary"
              icon="pi pi-arrow-right"
              icon-pos="right"
            />
          </template>
        </JtsSurface>
      </div>
    </div>
  </section>
</template>
