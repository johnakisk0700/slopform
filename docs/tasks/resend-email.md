# Resend email follow-up

Status: queued after the minimal integration.

The current worker can send a text email through Resend when
`RESEND_API_KEY` and a verified `RESEND_FROM_EMAIL` are configured. It keeps
the delivery id as the idempotency key, bounds retries, and records blocked,
sent, retry-scheduled and failed outcomes. This task covers the production
decisions that were intentionally left out of that first slice.

## Follow-up

- Confirm the verified sender/domain and DNS setup in the target Resend account.
- Decide the first real email template and whether HTML is needed beside the
  current text body.
- Decide whether delivery, bounce and complaint webhooks are needed, then add
  only the events the product will act on.
- Set message retention and operator-visible delivery history for the stored
  recipient, subject and body.
- Run one staging smoke with a test recipient and verify the sent, retry and
  permanent-failure records without placing credentials in logs.

## Acceptance

Document the sender, template, webhook and retention decisions; exercise the
chosen staging path; and update the email delivery contract and focused tests
before changing the minimal adapter.

## References

- [Resend send email API](https://resend.com/docs/api-reference/emails/send-email)
- [Resend idempotency keys](https://resend.com/docs/dashboard/emails/idempotency-keys)
- [Resend webhooks](https://resend.com/docs/webhooks/introduction)
