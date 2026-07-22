# RegistrationForm

`RegistrationForm` owns the interactive seat-request field preview and client
validation. It does not submit, load event details, decide eligibility or
confirm a seat while the backend registration contract is absent.

Source: [`RegistrationForm.vue`](../../../apps/web/app/components/registration/RegistrationForm.vue)

The component has no props, slots or emitted events. The route owns the preview
event context; no event identifier or participant data leaves the browser.

The Zod schema in `app/features/registration/schema.ts` owns client parsing.
Errors are connected with `aria-describedby`; required controls also retain
native semantics. The disabled action states that registration is preview-only;
the form must not simulate success or a retryable API failure.

SSR-visible Checkbox, InputText, Select and Textarea stay in the PrimeVue Nuxt
allow-list. Change fields in the schema and form together. Add submission only
after a matching backend route, request/response schema, consent policy and
failure contract exist; event loading, availability and booking policy remain
at the route/API boundary.

Focused tests: `apps/web/test/registration-schema.spec.ts`.
