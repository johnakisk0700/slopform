<script setup lang="ts">
import {
  dietaryOptions,
  getRegistrationErrors,
  type RegistrationField,
} from "~/features/registration/schema";

const errors = ref<Partial<Record<RegistrationField, string>>>({});
const form = reactive({
  fullName: "",
  email: "",
  dietaryPreference: "none" as "none" | "vegetarian" | "vegan",
  note: "",
  privacyAccepted: false,
});

function validate(): boolean {
  errors.value = getRegistrationErrors(form);
  return Object.keys(errors.value).length === 0;
}
</script>

<template>
  <form class="surface-card form-card form-grid" novalidate @submit.prevent>
    <div class="form-heading">
      <p class="eyebrow">Your details</p>
      <h2>Request a place at this table</h2>
      <p>
        Preview the information a future seat request will need. Submission is
        not connected yet.
      </p>
    </div>

    <div class="field">
      <label for="registration-name">Full name <span>Required</span></label>
      <InputText
        id="registration-name"
        v-model="form.fullName"
        required
        autocomplete="name"
        :invalid="Boolean(errors.fullName)"
        :aria-describedby="
          errors.fullName ? 'registration-name-error' : undefined
        "
        @blur="validate"
      />
      <p
        v-if="errors.fullName"
        id="registration-name-error"
        class="field-error"
      >
        {{ errors.fullName }}
      </p>
    </div>

    <div class="field">
      <label for="registration-email">Email <span>Required</span></label>
      <InputText
        id="registration-email"
        v-model="form.email"
        type="email"
        required
        autocomplete="email"
        inputmode="email"
        :invalid="Boolean(errors.email)"
        :aria-describedby="
          errors.email ? 'registration-email-error' : undefined
        "
        @blur="validate"
      />
      <p v-if="errors.email" id="registration-email-error" class="field-error">
        {{ errors.email }}
      </p>
    </div>

    <div class="field">
      <label for="registration-diet">Dietary preference</label>
      <Select
        v-model="form.dietaryPreference"
        input-id="registration-diet"
        :options="dietaryOptions"
        option-label="label"
        option-value="value"
      />
    </div>

    <div class="field">
      <label for="registration-note">Anything we should know?</label>
      <Textarea
        id="registration-note"
        v-model="form.note"
        rows="4"
        maxlength="500"
        auto-resize
        :invalid="Boolean(errors.note)"
        :aria-describedby="
          errors.note
            ? 'registration-note-help registration-note-error'
            : 'registration-note-help'
        "
        @blur="validate"
      />
      <p id="registration-note-help" class="field-help">
        Accessibility needs or useful context. Do not include sensitive medical
        details.
      </p>
      <p v-if="errors.note" id="registration-note-error" class="field-error">
        {{ errors.note }}
      </p>
    </div>

    <div class="checkbox-field">
      <Checkbox
        v-model="form.privacyAccepted"
        input-id="registration-privacy"
        binary
        required
        :invalid="Boolean(errors.privacyAccepted)"
        :pt="{
          input: {
            'aria-describedby': errors.privacyAccepted
              ? 'registration-privacy-error'
              : undefined,
          },
        }"
        @change="validate"
      />
      <div>
        <label for="registration-privacy">
          I have read the current
          <NuxtLink to="/legal/privacy">privacy notice scaffold</NuxtLink>
          (required).
        </label>
        <p
          v-if="errors.privacyAccepted"
          id="registration-privacy-error"
          class="field-error"
        >
          {{ errors.privacyAccepted }}
        </p>
      </div>
    </div>

    <div class="form-actions">
      <Button label="Registration preview only" icon="pi pi-lock" disabled />
      <span class="field-help">
        Submission opens only after the registration API and policy are agreed.
      </span>
    </div>
  </form>
</template>
