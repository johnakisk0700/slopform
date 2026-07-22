<script setup lang="ts">
import {
  dietaryOptions,
  getRegistrationErrors,
  registrationSchema,
  type RegistrationField,
} from "~/features/registration/schema";

const props = defineProps<{
  eventSlug: string;
}>();

const api = useApi();
const submitting = ref(false);
const submitted = ref(false);
const submitError = ref("");
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

async function focusFirstInvalidField(): Promise<void> {
  const fieldOrder: Array<[RegistrationField, string]> = [
    ["fullName", "registration-name"],
    ["email", "registration-email"],
    ["dietaryPreference", "registration-diet"],
    ["note", "registration-note"],
    ["privacyAccepted", "registration-privacy"],
  ];
  const firstError = fieldOrder.find(([field]) => errors.value[field]);

  if (firstError) {
    await nextTick();
    document.getElementById(firstError[1])?.focus();
  }
}

async function submit(): Promise<void> {
  submitError.value = "";
  submitted.value = false;

  if (!validate()) {
    await focusFirstInvalidField();
    return;
  }

  const payload = registrationSchema.parse(form);
  submitting.value = true;

  try {
    await api("/registrations", {
      method: "POST",
      body: {
        ...payload,
        eventSlug: props.eventSlug,
      },
    });
    submitted.value = true;
  } catch {
    submitError.value =
      "We could not send your registration. Please try again in a moment.";
  } finally {
    submitting.value = false;
  }
}
</script>

<template>
  <form
    class="surface-card form-card form-grid"
    novalidate
    @submit.prevent="submit"
  >
    <div v-if="submitted" class="form-success" role="status">
      <span class="pi pi-check-circle" aria-hidden="true" />
      <div>
        <h2>Request received.</h2>
        <p>
          Check your email for next steps. This request is not a confirmed seat.
        </p>
      </div>
    </div>

    <template v-else>
      <div class="form-heading">
        <p class="eyebrow">Your details</p>
        <h2>Request a place at this table</h2>
        <p>Fields marked required must be completed before we can send this.</p>
      </div>

      <Message v-if="submitError" severity="error" :closable="false">
        {{ submitError }}
      </Message>

      <div class="field">
        <label for="registration-name">Full name <span>Required</span></label>
        <InputText
          id="registration-name"
          v-model="form.fullName"
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
          autocomplete="email"
          inputmode="email"
          :invalid="Boolean(errors.email)"
          :aria-describedby="
            errors.email ? 'registration-email-error' : undefined
          "
          @blur="validate"
        />
        <p
          v-if="errors.email"
          id="registration-email-error"
          class="field-error"
        >
          {{ errors.email }}
        </p>
      </div>

      <div class="field">
        <label for="registration-diet">Dietary preference</label>
        <Select
          input-id="registration-diet"
          v-model="form.dietaryPreference"
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
          Accessibility needs or useful context. Do not include sensitive
          medical details.
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
            <NuxtLink to="/legal/privacy">privacy notice scaffold</NuxtLink>.
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
        <Button
          type="submit"
          label="Send seat request"
          icon="pi pi-arrow-right"
          icon-pos="right"
          :loading="submitting"
        />
        <span class="field-help">
          Submitting this preview does not confirm a seat.
        </span>
      </div>
    </template>
  </form>
</template>
