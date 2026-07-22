<script setup lang="ts">
useSeoMeta({ title: "Privacy notice" });
</script>

<template>
  <article class="public-page">
    <div class="container policy-content">
      <p class="eyebrow">Policy scaffold</p>
      <h1 class="public-page__title">Privacy notice</h1>
      <Message severity="warn" :closable="false">
        Legal copy is intentionally not fabricated. Replace this scaffold after
        counsel confirms the controller, purposes, retention periods and
        participant rights.
      </Message>
      <h2>Information this product expects to process</h2>
      <p>
        Contact details, dinner registration information, operational attendance
        data and payment references. Sensitive information must not be collected
        without a documented purpose and retention rule.
      </p>
      <h2>Your rights and contact details</h2>
      <p>
        The final notice must identify the correct contact channel and explain
        access, correction, deletion and objection rights in plain language.
      </p>
    </div>
  </article>
</template>
