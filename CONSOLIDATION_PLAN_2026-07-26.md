# Repo consolidation plan

## What is actually wrong

Three things, in order of cost.

**One rule, many copies.** `noteSignature` (`post-event-feedback-extractor.service.ts:1045`) and
`noteIdentity` (`post-event-feedback-extraction-validation.ts:568`) are byte-identical and together
form the replay guard for `feedback_notes`; if they drift, a replayed run writes a participant's
disclosure twice. The campaign copy snapshot has four resolvers under four names
(`extractor.service.ts:1061`, `materializer.service.ts:894`, `campaign.service.ts:526`,
`sweep.service.ts:448`) that have already diverged. The questionnaire vocabulary is declared twice —
`packages/database/src/schema/post-event-feedback.ts:28,38` and
`post-event-feedback-question-set.ts:3,10` — and one file imports both. Seven backend modules declare
the same `z.string().min(1).max(200)` principal. Eight admin files hand-write the same
`errorMessage(cause, fallback)`, in two variants. Four spec files re-declare `FakeDatabase`.

**Directory boundaries that point at each other.** `modules/conversations/feedback-conversation.*`
has 27 importers, all in `post-event-feedback/`, and imports back into it
(`feedback-conversation.schemas.ts:9-10`). `integrations/wasender/wasender.controller.ts:19` imports
the product module while `post-event-feedback/wasender-feedback-transport.service.ts:4` imports back.

**A flat folder doing a namespace's job.** 46 production files in `post-event-feedback/`, 30 sharing
a 20-character prefix, which is why `extraction.service.ts` and `extractor.service.ts` — the provider
boundary and the run — sit one letter apart. Four files exceed 900 lines
(`feedback-simulator.service.ts` 1077, `post-event-feedback-extractor.service.ts` 1125,
`post-event-feedback.repository.ts` 1049, `feedback-conversation.repository.ts` 1051), each with a
large contiguous tail of pure functions.

Everything else — the seven loop scenario suites, `labels.ts`, the infra wrappers, the colour tokens
— is already clean and is left alone.

## Decisions

1. `conversations/feedback-conversation.{schemas,repository}.ts` moves into `post-event-feedback/`;
   the split is accidental (27 of 31 importers are that module, and it imports back), so
   `conversations/` narrows to the schema-v1 assistant aggregate.
2. Those two files land at the `post-event-feedback/` **root**, not inside a subfolder, because
   `inbox/`, `extraction/` and `ingress/` all read them.
3. The shared principal/correlation schemas live in `infrastructure/auth/auth.schemas.ts` — it
   already exists and already holds `authSessionSchema` — not in the decorator file.
4. Configuration stays **central**: `environment.ts` splits by mechanism (Mongo URI surgery,
   pre-boot toggles), never per product domain. `ConfigModule.forRoot` takes one `validate`.
5. Wasender dependency runs one way, `modules → integrations`: the webhook controller moves out of
   `integrations/`, and `phoneE164ToChatJid` moves in, next to the parser that already exists there.
6. `packages/database` owns the questionnaire vocabulary; the `POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS`
   / `_NOTE_TYPES` copies are deleted (verified literal-identical).
7. `ConversationLike` gets both fixes: its unions come from the generated client, and the `-Like`
   suffix goes.
8. Caps-overline is one packet, not two: add the missing `--jts-text-2xs` scale step, then one
   Tailwind `@utility` that consumes it.
9. The materializer is **not** split beyond its four pure helpers — `withPendingIngress`
   (`materializer.service.ts:824-841`) is the module's replay guarantee and must have exactly one owner.
10. The doubles harness drops `loop` from its name; the five `FakeConversations` classes stay
    separate — merging them builds a god-double coupling five unrelated specs.
11. No new shared package anywhere. `apps/admin/src/api/generated/**` is never touched by hand.

## Target structure

### `apps/backend/src/modules/post-event-feedback/` (46 production files, flat → 8 folders + root)

```
before                                    after
post-event-feedback-campaign.*            campaign/campaign.{service,controller,schemas,repository}.ts
post-event-feedback-conversation.*        inbox/conversation.{service,controller,schemas}.ts
  (+ L662-821 of the service)             inbox/conversation.view.ts
post-event-feedback-extraction.service    extraction/model.service.ts
post-event-feedback-extractor.service     extraction/extract.service.ts
post-event-feedback-extraction-*.ts       extraction/{extraction.schemas,validate-proposal,fallback.service}.ts
post-event-feedback-prompt.ts             extraction/prompt.ts
post-event-feedback-attention-classif.    extraction/attention-classification.ts
post-event-feedback-provider-safety.ts    extraction/permissive-safety-settings.ts
post-event-feedback-materializer.service  ingress/materialize.service.ts
post-event-feedback-ingress.*             ingress/ingress.{service,module,repository}.ts
message-outbox-*.ts, feedback-transport,  outbox/{relay,deliver,delivery-status,transport,
  *-feedback-transport.service,             wasender-transport,simulated-transport,session-pacer,
  feedback-session-pacer,                   outbound-transcript,relay-scheduler,outbox.repository}.ts
  feedback-outbound-transcript,
  feedback-outbox-scheduler
post-event-feedback-sweep.service         sweeps/sweep.service.ts
feedback-sweep-scheduler.service          sweeps/sweep-scheduler.service.ts
feedback-simulator.*                      simulator/simulator.{service,controller,schemas}.ts
post-event-feedback-simulator-http.mod    simulator/http.module.ts
feedback-simulator-phone.ts               (deleted → integrations/wasender/wasender.jid.ts)
post-event-feedback-stop-matcher.ts       matching/{stop-command,fold-text}.ts
post-event-feedback-name-matcher.ts       matching/candidate-name.ts
post-event-feedback.repository.ts (1049)  (deleted → 5 per-table repositories above)
../conversations/feedback-conversation.*  post-event-feedback-conversation.{document,repository}.ts
post-event-feedback-question-set.ts       question-set.ts          } root: shared vocabulary,
post-event-feedback-attention.ts          attention.ts             } observability, queue contract,
post-event-feedback.schemas.ts            jobs.schemas.ts          } Nest wiring
post-event-feedback-metrics.service.ts    metrics.service.ts
feedback-operator-alert.ts                operator-alert.ts
post-event-feedback.processor.ts          processor.ts
post-event-feedback-{core,http,worker}.   {core,http,worker}.module.ts
post-event-feedback-loop-doubles.harness  post-event-feedback-doubles.harness.ts
post-event-feedback-loop.harness (1902)   + post-event-feedback-loop-scenario.ts
                                          + post-event-feedback-loop-model.harness.ts
```

### `apps/admin/src/` (only what changes)

```
before                                    after
(errorMessage × 8, two variants)          lib/api.ts :: apiErrorMessage
(toLocaleString en-GB × 3)                lib/dateTime.ts :: formatDateTime
routes/AssistantPage.tsx L82-183          features/assistant/{composerSettings,failureMessages}.ts
routes/FeedbackResultsPage.tsx L41-53     components/admin/feedback/ParticipantName.tsx
routes/FeedbackInboxPage.tsx L391-515     components/admin/feedback/CampaignHeader.tsx
(font-extrabold uppercase … × 28)         styles/globals.css :: @utility overline
```

## Shared extractions

| What                                                                                                                                | New home                                                                                                     | Call sites                                                                                                                                                                                      | Packet                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `errorMessage` / `requestErrorMessage` → `apiErrorMessage`                                                                          | `apps/admin/src/lib/api.ts`                                                                                  | 8 (`FeedbackInboxPage:70`, `FeedbackResultsPage:35`, `FeedbackCampaignsPage:19`, `ParticipantProfilePage:37`, `EventDetailPage:30`, `EventsPage:47`, `ParticipantsPage:18`, `AddNoteAction:34`) | WP-07                      |
| `FakeDatabase` (4), `FakeAudit` (3), `FakeParticipants` (4), `FakeQueue` (2), `FakeEvents` (2)                                      | `post-event-feedback-doubles.harness.ts` (renamed)                                                           | 15                                                                                                                                                                                              | WP-16                      |
| `principalSchema` / `correlationIdSchema`                                                                                           | `infrastructure/auth/auth.schemas.ts`                                                                        | 7 modules (`events:17`, `participants:5`, `email:42`, `assistant:63`, `pef-conversation:15`, `pef-campaign:7`, `pef.schemas:24`)                                                                | WP-09                      |
| `FEEDBACK_ANSWER_QUESTION_KEYS` / `FEEDBACK_NOTE_TYPES`                                                                             | `packages/database/src/schema/post-event-feedback.ts:28,38` (already there)                                  | 5 backend sites                                                                                                                                                                                 | WP-10                      |
| `noteSignature` (= `noteIdentity`)                                                                                                  | `post-event-feedback-question-set.ts`                                                                        | 2 (`extractor.service.ts:1045`, `extraction-validation.ts:568`)                                                                                                                                 | WP-11                      |
| `resolveCampaignCopy` (4 divergent resolvers)                                                                                       | `post-event-feedback-question-set.ts`                                                                        | 4 (`extractor:1061`, `materializer:894`, `campaign:526`, `sweep:448`)                                                                                                                           | WP-12                      |
| `latestParticipantMessage`                                                                                                          | `post-event-feedback-question-set.ts` sibling `conversation-reader.ts`                                       | 4 (`extractor:392`, `extractor:1033`, `fallback:324`, `sweep:396`)                                                                                                                              | WP-13                      |
| `--jts-text-2xs` token + `@utility overline`                                                                                        | `packages/design-tokens/src/tokens.css`, `apps/admin/src/styles/globals.css`                                 | ~28 class recipes / 30 arbitrary `text-[Nrem]`                                                                                                                                                  | WP-19                      |
| `formatDateTime`                                                                                                                    | `apps/admin/src/lib/dateTime.ts`                                                                             | 3 (`ParticipantProfilePage:92`, `EventsPage:30`, `AssistantPage:746`)                                                                                                                           | WP-08                      |
| `foldGreekAccents` / `foldPostEventFeedbackText` / `foldedTextContainsAtWordStart`                                                  | `matching/fold-text.ts` (split from stop-matcher)                                                            | 3 (`name-matcher:1`, `fallback:24`, `extraction-validation:3`)                                                                                                                                  | WP-14                      |
| `assertCleanSimulatorBaseline` (~130 duplicated lines)                                                                              | `feedback-simulator.service.ts`, private                                                                     | 2 (`:162`, `:335`)                                                                                                                                                                              | WP-22                      |
| Four remaining 2-site dedupes: `OUTBOX_RELAY_JOB_OPTIONS`, `phoneE164ToChatJid`, `estimatePromptTokens`, `isRetryableProviderError` | `queue.constants.ts`, `integrations/wasender/wasender.jid.ts`, `extraction/prompt.ts`, `assistant-models.ts` | 2 each                                                                                                                                                                                          | WP-15, WP-17, WP-18, WP-20 |

## Rejected

| Candidate                                                                                    | Why not                                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JtsBackLink` (2 sites)                                                                      | A new `Jts*` contract costs a `docs/frontend/components/*.md` + README row for 6 lines of markup. The overline utility captures the shared vocabulary in CSS.       |
| `JtsSectionHeading` (2 sites)                                                                | Same cost, and the two differ in heading level and wrapper — they are not one component.                                                                            |
| Split `post-event-feedback-materializer.service.ts` inbound/outbound arms                    | Two owners of `withPendingIngress` is a correctness regression no test catches. Move only the four pure helpers at L852-907.                                        |
| Split `post-event-feedback-extraction-validation.ts` (600 lines)                             | One pure function with three private passes; the doc comment at L27-51 is the rule index. Splitting scatters §7 across three files.                                 |
| Rename `conversationView.ts` → `conversationInbox.ts`, move `formatTimestamp` to `labels.ts` | Pure taste, zero duplication removed, import churn across `routes/` and `components/admin/`.                                                                        |
| Move `lib/feedbackSimulator.ts` → `features/feedback/`                                       | A move with no duplication behind it.                                                                                                                               |
| Rename `QueueModule` → `QueueProducerModule`                                                 | 8 module files + specs for a rename, guaranteed to conflict with the in-flight `feat/feedback-loop-remediation` branch.                                             |
| Split `packages/database/src/schema/post-event-feedback.ts` campaigns/transport              | `messageOutbox.campaignId` is a `notNull` FK to `feedbackCampaigns` (L413-417); the halves are not independent. Only the dev-only sink at L467-504 is worth moving. |
| Split `apps/admin/test/feedback-inbox.spec.ts` (657 lines)                                   | Long but not tangled; describe blocks already partition it.                                                                                                         |
| Split `post-event-feedback-loop-lifecycle.spec.ts`                                           | The report calls it taste, not a defect. It is already two `runFeedbackScenarios` calls and reads fine.                                                             |
| Extract `OverviewPage` fixtures / page-local `Stamp`/`QueueRow`/`CopperNote`/`FocusCard`     | Stated preview state pending the operations API; correctly page-local and must not become `Jts*`. Delete the screen when the API lands.                             |
| Convert fixtures/corpus to JSON                                                              | Destroys the `satisfies`-derived literal unions; `post-event-feedback-real-model-corpus.ts` is imported by production code (`feedback-simulator.service.ts:47`).    |
| Extract the transaction + `audit.append` block in `EventsService`/`ParticipantsService`      | Four explicit lines with a per-action payload. Wrapping hides the audit record. This is the speculative abstraction the taste rules forbid.                         |

## Work packets

Each packet is one commit. Read `AGENTS.md` first. Run the packet's verification command before
handoff; run `pnpm check` only if the packet says so.

Every packet is declared **MOVE** or **SIMPLIFY**. The two are never combined in one commit — see
the execution contract for what each one is allowed to change and what proves it.

### Group 0 — measurement (before any code changes)

**WP-00 · Measure what we are about to change** — MOVE (no source files change)

- Add `@vitest/coverage-v8` as a devDependency of `apps/backend` and `apps/admin`; add a `coverage`
  script and commit the per-file report path to `.gitignore`, not the report.
- Record the baseline in this file under "Baseline": coverage per file for every file named in
  Groups B and C, and a one-off `npx jscpd --min-lines 8 --reporters json` over the 327 handwritten
  source files (no permanent dependency).
- Every later SIMPLIFY packet reads its target's coverage number from that table. A SIMPLIFY packet
  whose target file has no covering test is blocked, not attempted.
- Done when: the coverage table exists, `pnpm test` still reports 669 passing, and no file under
  `apps/*/src` or `packages/*/src` has changed.
- Verify: `pnpm test`
- Effort: S · Depends on: nothing · **Do not** add coverage thresholds to CI in this packet.

## Baseline

Measured 2026-07-26 on branch `chore/consolidation` before Group B/C work. **Line coverage** is
statement-derived from vitest v8 `coverage/coverage-final.json` after `pnpm --filter
@join-the-six/backend coverage` and `pnpm --filter @join-the-six/admin coverage`. **`n/a`** means the
path does not exist yet (planned extraction) or is not instrumented (CSS, `package.json`,
`packages/database` — no vitest coverage in this packet). **0.0** means the file exists but had no
executed lines in the admin suite (routes and most page components).

### Duplication — measured, not estimated

`npx jscpd --min-lines 8 --min-tokens 50` over `apps/*/src` and `packages/database/src`, generated
output excluded, run 2026-07-26.

| Format     | Files | Lines  | Duplicated        |
| ---------- | ----- | ------ | ----------------- |
| TypeScript | 260   | 53,393 | 1,461 (2.74%)     |
| TSX        | 39    | 8,230  | 11 (0.13%)        |
| CSS        | 1     | 600    | 0                 |
| **Total**  | 300   | 62,223 | **1,472 (2.37%)** |

122 clones. This repo is not half copy-paste: the admin app is 0.13% duplicated, and most of the 122
are Drizzle column declarations repeated across `schema/assistant.ts`, `schema/post-event-feedback.ts`
and `schema/email-deliveries.ts` — identical because table definitions are identical, and not
removable without an abstraction layer over the schema, which the taste rules forbid.

The duplication worth removing is dangerous rather than voluminous. `noteSignature` exists twice and
is the `feedback_notes` replay guard; the campaign copy rule exists four times and has already
diverged. Six clones matter; Group B takes those.

### Coverage — Groups B and C targets

| Packet(s)           | File                                                                                                    | Lines % |
| ------------------- | ------------------------------------------------------------------------------------------------------- | ------- |
| WP-07               | `apps/admin/src/components/admin/feedback/AddNoteAction.tsx`                                            | 0.0     |
| WP-34               | `apps/admin/src/components/admin/feedback/CampaignHeader.tsx` (new in WP-34)                            | n/a     |
| WP-21               | `apps/admin/src/components/admin/feedback/ConversationDetails.tsx`                                      | 0.0     |
| WP-21               | `apps/admin/src/components/admin/feedback/ParticipantName.tsx` (new in WP-21)                           | n/a     |
| WP-34               | `apps/admin/src/features/assistant/composerSettings.ts` (new in WP-34)                                  | n/a     |
| WP-34               | `apps/admin/src/features/assistant/failureMessages.ts` (new in WP-34)                                   | n/a     |
| WP-24               | `apps/admin/src/features/feedback/conversationView.ts`                                                  | 88.8    |
| WP-24               | `apps/admin/src/features/feedback/labels.ts`                                                            | 89.2    |
| WP-07               | `apps/admin/src/lib/api.ts`                                                                             | 0.0     |
| WP-08               | `apps/admin/src/lib/dateTime.ts` (new in WP-08)                                                         | n/a     |
| WP-08, WP-34        | `apps/admin/src/routes/AssistantPage.tsx`                                                               | 0.0     |
| WP-07               | `apps/admin/src/routes/EventDetailPage.tsx`                                                             | 0.0     |
| WP-07               | `apps/admin/src/routes/EventsPage.tsx`                                                                  | 0.0     |
| WP-07               | `apps/admin/src/routes/FeedbackCampaignsPage.tsx`                                                       | 0.0     |
| WP-07, WP-34        | `apps/admin/src/routes/FeedbackInboxPage.tsx`                                                           | 0.0     |
| WP-07               | `apps/admin/src/routes/FeedbackResultsPage.tsx`                                                         | 0.0     |
| WP-07               | `apps/admin/src/routes/ParticipantProfilePage.tsx`                                                      | 0.0     |
| WP-07               | `apps/admin/src/routes/ParticipantsPage.tsx`                                                            | 0.0     |
| WP-19               | `apps/admin/src/styles/globals.css`                                                                     | n/a     |
| WP-09               | `apps/backend/src/infrastructure/auth/auth.schemas.ts`                                                  | 100.0   |
| WP-26               | `apps/backend/src/infrastructure/config/enabled-modules.ts` (new in WP-26)                              | n/a     |
| WP-26               | `apps/backend/src/infrastructure/config/environment-values.ts` (new in WP-26)                           | n/a     |
| WP-26               | `apps/backend/src/infrastructure/config/environment.ts`                                                 | 100.0   |
| WP-26               | `apps/backend/src/infrastructure/config/mongo-connection-string.ts` (new in WP-26)                      | n/a     |
| WP-26               | `apps/backend/src/infrastructure/config/observability-environment.ts`                                   | 100.0   |
| WP-15               | `apps/backend/src/infrastructure/queue/queue.constants.ts`                                              | 100.0   |
| WP-17               | `apps/backend/src/integrations/wasender/wasender.jid.ts` (new in WP-17)                                 | n/a     |
| WP-20               | `apps/backend/src/modules/assistant/assistant-generation.service.ts`                                    | 98.2    |
| WP-20               | `apps/backend/src/modules/assistant/assistant-models.ts`                                                | 100.0   |
| WP-27               | `apps/backend/src/modules/assistant/assistant-turn-view.ts` (new in WP-27)                              | n/a     |
| WP-09               | `apps/backend/src/modules/assistant/assistant.schemas.ts`                                               | 100.0   |
| WP-27               | `apps/backend/src/modules/assistant/assistant.service.ts`                                               | 99.7    |
| WP-23, WP-28        | `apps/backend/src/modules/conversations/feedback-conversation.repository.ts`                            | 100.0   |
| WP-10, WP-28        | `apps/backend/src/modules/conversations/feedback-conversation.schemas.ts`                               | 100.0   |
| WP-15               | `apps/backend/src/modules/email/email-outbox-relay.service.ts`                                          | 100.0   |
| WP-09               | `apps/backend/src/modules/email/email.schemas.ts`                                                       | 100.0   |
| WP-09               | `apps/backend/src/modules/events/events.schemas.ts`                                                     | 100.0   |
| WP-09               | `apps/backend/src/modules/participants/participants.schemas.ts`                                         | 100.0   |
| WP-13               | `apps/backend/src/modules/post-event-feedback/conversation-reader.ts` (new in WP-13)                    | n/a     |
| WP-17               | `apps/backend/src/modules/post-event-feedback/feedback-simulator-phone.ts`                              | 100.0   |
| WP-10, WP-22, WP-33 | `apps/backend/src/modules/post-event-feedback/feedback-simulator.service.ts`                            | 97.7    |
| WP-14               | `apps/backend/src/modules/post-event-feedback/matching/fold-text.ts` (new in WP-14)                     | n/a     |
| WP-15               | `apps/backend/src/modules/post-event-feedback/message-outbox-relay.service.ts`                          | 100.0   |
| WP-18               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-attention-classification.ts`          | 97.0    |
| WP-09               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-campaign.schemas.ts`                  | 100.0   |
| WP-12               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-campaign.service.ts`                  | 98.0    |
| WP-09               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.schemas.ts`              | 100.0   |
| WP-29               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-conversation.service.ts`              | 99.7    |
| WP-13               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-extraction-fallback.service.ts`       | 100.0   |
| WP-11               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-extraction-validation.ts`             | 100.0   |
| WP-20               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-extraction.service.ts`                | 94.5    |
| WP-11, WP-30        | `apps/backend/src/modules/post-event-feedback/post-event-feedback-extractor.service.ts`                 | 99.8    |
| WP-16               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-loop-doubles.harness.ts`              | 90.0    |
| WP-32               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-loop-model.harness.ts` (new in WP-32) | n/a     |
| WP-32               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-loop-scenario.ts` (new in WP-32)      | n/a     |
| WP-17, WP-32        | `apps/backend/src/modules/post-event-feedback/post-event-feedback-loop.harness.ts`                      | 99.6    |
| WP-12, WP-31        | `apps/backend/src/modules/post-event-feedback/post-event-feedback-materializer.service.ts`              | 99.5    |
| WP-14               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-name-matcher.ts`                      | 100.0   |
| WP-18               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-prompt.ts`                            | 100.0   |
| WP-10               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-question-set.ts`                      | 100.0   |
| WP-14               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-stop-matcher.ts`                      | 100.0   |
| WP-12               | `apps/backend/src/modules/post-event-feedback/post-event-feedback-sweep.service.ts`                     | 99.7    |
| WP-09               | `apps/backend/src/modules/post-event-feedback/post-event-feedback.schemas.ts`                           | 100.0   |
| WP-35               | `packages/database/src/schema/feedback-sim-outbound.ts` (new in WP-35)                                  | n/a     |
| WP-35               | `packages/database/src/schema/post-event-feedback.ts`                                                   | n/a     |
| WP-25               | `packages/design-tokens/package.json`                                                                   | n/a     |
| WP-19               | `packages/design-tokens/src/tokens.css`                                                                 | n/a     |

### jscpd (one-off, no repo dependency)

```bash
npx jscpd --min-lines 8 --reporters json \
  apps/admin/src apps/backend/src packages/database/src packages/design-tokens/src \
  --ignore '**/api/generated/**'
```

Writes `report/jscpd-report.json` (gitignored, not committed). Census in the same scan:

| sources | lines  | duplicated lines | % lines duplicated |
| ------- | ------ | ---------------- | ------------------ |
| 301     | 62,664 | 1,472            | 2.35               |

Campaign table above cites **327** handwritten source files (63,641 lines); this jscpd invocation
scans **301** paths under the four `src` trees (excludes `apps/admin/test` and other paths outside
those roots). Use the totals row for duplicate-line trend only.

**WP-0B · Stop tracking the generated admin client** — MOVE (no source semantics change)

The client is a deterministic function of `openapi.json` + `orval.config.ts`. Committing it adds 166
files and 13,053 lines of review noise for no safety the committed contract does not already give.
`openapi.json` stays tracked — it is the contract, it is one file, and its diff is the review signal
ADR 0009 actually wanted.

- `git rm -r --cached apps/admin/src/api/generated`, add it to `.gitignore`.
- `turbo.json`: `api:generate` becomes `cache: true` with
  `outputs: ["apps/admin/src/api/generated/**"]` (today it is `cache: false`, `outputs: []`), and
  admin `typecheck`, `lint`, `test` and `build` gain it in `dependsOn`.
- `scripts/verify-generated-api.mjs` fingerprints the filesystem, not git, so on a fresh clone the
  "before" set is empty and the comparison is meaningless. Narrow its comparison to
  `apps/backend/openapi/openapi.json` and let the client be produced, not diffed.
- Write `docs/decisions/0010-generated-client-not-committed.md` superseding the "committed artifact"
  consequence of ADR 0009 — the rest of 0009 stands. Add it to the `docs/README.md` list.
- `AGENTS.md`: the line "committing the regenerated artifact **and client** in the same change" is no
  longer true. Fix it in this packet.
- Done when: `apps/admin/src/api/generated` is untracked and ignored, ADR 0010 exists and is linked,
  and a **fresh worktree** with no generated directory passes the gate.
- Verify: `git worktree add ../jts-clean-check HEAD && cd ../jts-clean-check && pnpm install && pnpm check`
  — this is the only verification that proves it; a local `pnpm check` passes on stale artifacts.
- Effort: M · Depends on: nothing · **Do not** untrack `openapi.json` too, and do not touch a single
  line inside the generated directory on the way out.

### Group A — deletions and de-exports (no dependencies, do these first)

**WP-01 — Delete unused `$inferInsert` aliases in `packages/database`** · S · deps: none
Files: `packages/database/src/schema/{post-event-feedback,participants,events,assistant,audit-events,reference-records}.ts`, `packages/database/src/client.ts`
Delete `FeedbackCampaignInsert`, `FeedbackAnswerInsert`, `FeedbackNoteInsert`, `ProviderMessageIngressInsert`, `MessageOutboxInsert`, `FeedbackSimOutboundInsert`, `ParticipantInsert`, `ParticipantInterestInsert`, `ParticipantSourceRecordInsert`, `EventInsert`, `EventAttendeeInsert`, `AssistantThreadInsert`, `AssistantTurnInsert`, `AuditEventRow`, `ReferenceRecordInsert`. Drop the `export` on `CreateDatabaseOptions` (`client.ts:16`).
Done: each symbol verified at 0 references outside its declaring file across `apps/*/src`, `apps/*/test`, `packages/*/src`, `scripts/`.
Verify: `pnpm --filter @join-the-six/database build && pnpm --filter @join-the-six/backend build`
Do not: touch `AuditEventInsert` or any `*Row` type — `AuditEventInsert` is live in `infrastructure/audit/audit.repository.ts:4`.

**WP-02 — Admin: delete `ApiClient`, drop 20 stray `export` keywords** · S · deps: none
Files: `apps/admin/src/lib/{api,env,feedbackSimulator}.ts`, `features/feedback/{conversationView,simulator}.ts`, `features/assistant/schema.ts`, `features/event/schema.ts`, the 10 `*Props` types under `components/admin/`
Delete `ApiClient` (`api.ts:43`, 0 refs). Drop `export` on `createApiHeaders`, `validateEnv`, `foldForSearch`, `getFeedbackSimulatorThreadQueryKey`, `simulatorPhoneSchema`, `simulatorThreadMessageSchema`, `assistantEffortSchema`, `assistantTurnRequestSchema`, `assistantFailureSchema`, `AssistantModelOption`, `AssistantTurnRequest`, `EventPreviewField`, and the ten `AdminNavigationProps`-style types.
Done: `pnpm --filter @join-the-six/admin typecheck` clean and all specs green.
Verify: `pnpm --filter @join-the-six/admin typecheck && pnpm --filter @join-the-six/admin test`
Do not: touch `lib/useTheme.ts` — `test/theme-switch.spec.ts:88` asserts on the literal source text `"export const THEME_STORAGE_KEY"`. Do not touch `Jts*Props` in `components/ui/` (published contracts) or exported `*Schema` consts feeding `createZodDto`.

**WP-03 — Backend infra + non-feedback modules: drop stray `export` keywords** · S · deps: none
Files: `infrastructure/openapi/openapi-document.ts`, `infrastructure/observability/startup-failure.ts`, `infrastructure/queue/{bull-board-auth.middleware,redis-connection}.ts`, `modules/email/{email-outbox-relay.service,email.processor,email-scheduler.service}.ts`, `modules/assistant/{assistant-generation.service,assistant-recovery.service}.ts`
Drop `export` on `OPENAPI_TITLE/DESCRIPTION/VERSION`, the four `EMAIL_OUTBOX_*`/`EMAIL_DISPATCH_RECOVERY_MS`, `EMAIL_DELIVERY_LEASE_MS`, `EMAIL_OUTBOX_RELAY_SCHEDULER_ID/_INTERVAL_MS`, `reasoningProviderOptions`, `ASSISTANT_RECOVERY_INTERVAL_MS`. Separately, rename `StartupFailureHandlers` to `StartupFailureReporting` — it stays exported.
Done: build passes with `declaration: true`.
Verify: `pnpm --filter @join-the-six/backend build && pnpm --filter @join-the-six/backend test`
Do not: touch `ASSISTANT_STALE_TURN_MS`, `ASSISTANT_RECOVERY_BATCH_SIZE`, `HTTP_*_MILLISECONDS`, `createQueueProducerOptions/WorkerOptions`, `validIncomingRequestId` — all are read by specs.
Amended 2026-07-26 after the first dispatch refused it, correctly. Three symbols left the drop list: `redisConnectionFromUrl` is imported and directly tested by `redis-connection.spec.ts:4` with its own describe block; `StartupFailureHandlers` (`startup-failure.ts:11`) and `BullBoardCredentials` (`bull-board-auth.middleware.ts:20`) are parameter types of exported functions, so unexporting them is TS4023 at build.

**WP-04 — Feedback module: drop stray `export` keywords** · S · deps: none
Files: `post-event-feedback/{post-event-feedback-conversation.service,post-event-feedback.processor,feedback-simulator.service,message-outbox-delivery-status,post-event-feedback-attention-classification,post-event-feedback-extraction-fallback.service,feedback-outbox-scheduler.service,feedback-sweep-scheduler.service}.ts`
Drop `export` on `noteOrigin`, `resolveExtractionFailureCause`, `feedbackSimulatorProgressPercent`, `MESSAGE_OUTBOX_DELIVERY_STATUS_RANK`, `FEEDBACK_ATTENTION_PRECEDING_CONTEXT_MESSAGES`, `resolveUniqueNamedSubject`, `FEEDBACK_OUTBOX_RELAY_SCHEDULER_ID`, `FEEDBACK_OUTBOX_RELAY_EVERY_MS`, and the three scheduler ids + `FEEDBACK_SWEEP_EVERY_MS` in `feedback-sweep-scheduler.service.ts`.
Done: build passes; no spec imports any of them.
Verify: `pnpm --filter @join-the-six/backend build && pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback`
Do not: bulk-unexport types. `tsconfig.json` sets `declaration: true` over `src/**/*.ts`; unexporting a type used in an exported signature raises TS4023 at build, not typecheck. Leave `conversationCapabilities` and `FEEDBACK_ATTENTION_CLASSIFICATION_BATCH_SIZE` exported.

**WP-05 — Delete `isEligibleFeedbackRespondent`** · S · deps: none
Files: `post-event-feedback-campaign.service.ts:539`, `post-event-feedback-campaign.service.spec.ts:58-89`
Delete the function and its describe block. Zero production callers; the real gate is the SQL predicate at `post-event-feedback.repository.ts:185-192`, and a hand-written shadow of an eligibility rule that is not the one that runs is worse than no test.
Done: `grep -rn isEligibleFeedbackRespondent apps/` returns nothing.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback/post-event-feedback-campaign.service.spec.ts`
Do not: try to "port" the assertions onto the SQL predicate. That needs a real DB test and is a separate decision.

**WP-06 — Delete five never-used loop-harness scenario knobs** · S · deps: none
File: `post-event-feedback-loop.harness.ts`
Delete `GARBAGE_PROPOSAL` (L801-827) + `ModelTurn.garbage` (L305) + its branch (L689); `ModelTurn.failTimes` (L303) + the guard at L741; `FeedbackScenario.knownCurrentUnconsumedExtractionCalls` (L544), simplifying the runner branch at L1820-1823 to `[]`; the `Cite` member `"first-new"` (L244) + both resolver branches (L899-902, L955-958); `FeedbackSeedOptions.intro` (L391), inlining `wantsIntro = true` at L1171. Also drop `export` on `parseDuration` (L215), `FEEDBACK_LOOP_START` (L164), `DEFAULT_PHONE` (L166), `DEFAULT_CANDIDATES` (L167).
Done: all seven `post-event-feedback-loop-*.spec.ts` pass unchanged.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback/post-event-feedback-loop`
Do not: unexport `DEFAULT_RESPONDENT` (`post-event-feedback-loop.spec.ts:2`) or any type — see the TS4023 note in WP-04.

### Group B — extractions (each depends only on Group A)

**WP-07 — `apiErrorMessage` in `lib/api.ts`** · S · deps: WP-02
Files: `apps/admin/src/lib/api.ts` + the 8 call sites listed in the extractions table.
Adopt the **guarded** variant (`cause instanceof Error && cause.message !== "" ? cause.message : fallback`) — the four unguarded copies change behaviour for an `Error` with an empty message, which is the correct outcome, but state it in the commit message.
This is the first **SIMPLIFY** packet, and the WP-00 baseline records every one of its eight call
sites at 0.0% coverage. So it also brings its own proof: add `apps/admin/test/api-error-message.spec.ts`
covering the three cases that distinguish the two variants — an `Error` with a message (returns the
message), an `Error` with an empty message (returns the fallback, the deliberate change), and a
non-`Error` cause (returns the fallback). The admin test count rises 101 → 104; declare it.
Done: zero remaining local `errorMessage`/`requestErrorMessage` definitions in `apps/admin/src`, and
the new spec passes.
Verify: `pnpm --filter @join-the-six/admin typecheck && pnpm --filter @join-the-six/admin test`
Do not: add a toast/notification layer while you are in there. Do not test the eight call sites — the
helper is what changed.

**WP-08 — `formatDateTime` in `lib/dateTime.ts`** · S · deps: none
Files: new `apps/admin/src/lib/dateTime.ts`; `routes/{ParticipantProfilePage,EventsPage,AssistantPage}.tsx`
One `toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })`.
Verify: `pnpm --filter @join-the-six/admin test`
Do not: fold in `conversationView.formatTimestamp` (deliberately same-day-relative) or `OverviewPage`'s UTC-pinned day-only formatter. Different products, not duplicates.

**WP-09 — One `principalSchema` / `correlationIdSchema`** · M · deps: WP-03
Files: `infrastructure/auth/auth.schemas.ts`; `modules/{events,participants,email,assistant}/*.schemas.ts`; `modules/post-event-feedback/post-event-feedback-{conversation,campaign}.schemas.ts`, `post-event-feedback.schemas.ts`
Declare `principalSchema` (`.max(200)`) and `correlationIdSchema` (`.max(128)`) once in
`auth.schemas.ts`, and **also declare one shared `PrincipalDto` / `CorrelationIdDto` pair there** via
`createZodDto`. Delete the seven prefixed schema pairs and the seven DTO wrapper pairs, then repoint
every `@CurrentUserId()` and `@RequestCorrelationId()` parameter annotation at the two shared DTO
classes. Leave `wasenderCorrelationIdSchema` alone for now — it moves with WP-24.
**The DTO wrappers are load-bearing, not ceremony.** A parameter's declared type is the metadata
`StrictZodValidationPipe` reads; annotating these parameters as `string` removes the schema from the
HTTP boundary and every request 500s. Typecheck and `api:check` both still pass in that state — only
the contract specs catch it.
Amended 2026-07-26 after the first dispatch did exactly that and failed with
`ZodSchemaDeclarationException` (backend 666/668).
Done: `pnpm api:check` shows no diff in `apps/backend/openapi/openapi.json`, and
`assistant-http.contract.spec.ts` passes all three of its cases.
Verify: `pnpm api:check && pnpm --filter @join-the-six/backend typecheck && pnpm --filter @join-the-six/backend test`
Do not: change any `max()` bound, make the schemas branded, or replace a DTO parameter annotation
with a primitive type. If `api:check` produces a diff, stop and report — do not commit a regenerated
client to make it pass.

**WP-10 — Delete the duplicated questionnaire vocabulary** · M · deps: none
Files: `post-event-feedback-question-set.ts`, `post-event-feedback-question-set.spec.ts`, `post-event-feedback-conversation.schemas.ts`, `conversations/feedback-conversation.schemas.ts`, `feedback-simulator.service.ts`, plus every importer of the two deleted consts.
Delete `POST_EVENT_FEEDBACK_ANSWER_QUESTION_KEYS`, `POST_EVENT_FEEDBACK_NOTE_TYPES`, `PostEventFeedbackAnswerQuestionKey`, `PostEventFeedbackNoteType`; re-export or import `FEEDBACK_ANSWER_QUESTION_KEYS`/`FEEDBACK_NOTE_TYPES` from `@join-the-six/database` (verified literal-identical). Move the assertion at `post-event-feedback-question-set.spec.ts:23` onto the surviving symbol.
Done: `post-event-feedback-conversation.schemas.ts` no longer imports the same vocabulary from two sources.
Verify: `pnpm --filter @join-the-six/backend typecheck && pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback`
Do not: interpolate the const arrays into the drizzle `check()` SQL in this packet — that changes generated DDL and needs `pnpm db:check`. Do not touch `POST_EVENT_FEEDBACK_COPY_KEYS` (no package twin).

**WP-11 — One `noteSignature`** · S · deps: none
Files: `post-event-feedback-extractor.service.ts:1045`, `post-event-feedback-extraction-validation.ts:568`, `post-event-feedback-question-set.ts`
Move the function to `post-event-feedback-question-set.ts` as `noteSignature`, import it in both, delete `noteIdentity`. Add a one-line comment saying it is the replay guard for `feedback_notes`, which has no natural unique key.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback/post-event-feedback-extraction-validation.spec.ts src/modules/post-event-feedback/post-event-feedback-extractor.service.spec.ts`
Do not: "improve" the normalisation (trim / collapse whitespace / lowercase). Changing it changes which historical notes are considered duplicates.

**WP-12 — One `resolveCampaignCopy`** · M · deps: WP-10 · **behaviour change, read carefully**
Files: `post-event-feedback-question-set.ts`; `post-event-feedback-{extractor.service,materializer.service,campaign.service,sweep.service}.ts`
The four resolvers are **not** equivalent: `campaign.service.ts:526` and `sweep.service.ts:448` return the stored snapshot verbatim with no per-key fallback (which is why `sweep.service.ts:437` casts `reminder_followup as string | undefined`), `extractor` merges per key, `materializer` bounds length. Unify on the **merging** version, keep length-bounding at the materializer call site, and delete the cast at `sweep.service.ts:437`.
Done: one `resolveCampaignCopy` in `question-set.ts`; four call sites; no defensive casts left.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback`
Do not: land this silently. A campaign launched before a copy key existed now sends the versioned default instead of nothing — say so in the commit message and update `docs/backend/modules/post-event-feedback.md`.

**WP-13 — One `latestParticipantMessage`** · M · deps: none
Files: new `post-event-feedback/conversation-reader.ts`; `post-event-feedback-{extractor.service,extraction-fallback.service,sweep.service}.ts`
Four hand-rolled scans (`extractor:392`, `extractor:1033`, `fallback:324`, `sweep:396`) — two walk backwards for the message, two scan forwards for the max timestamp. Return the message; callers read `seq`, `id`, `timestamp` off it. Carry the reasoning comment from `sweep.service.ts:390-395` (webhooks arrive out of order, so `messages.at(-1)` is wrong) onto the single function.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback`
Do not: generalise it to "latest message by role". One role, four call sites.

**WP-14 — Split text folding out of the STOP matcher** · S · deps: none
Files: `post-event-feedback-stop-matcher.ts` → keep `matchesPostEventFeedbackStopCommand`; new sibling holding L79-129 (`foldGreekAccents`, `foldPostEventFeedbackText`, `foldedTextContainsAtWordStart`). Update `post-event-feedback-name-matcher.ts:1`, `post-event-feedback-extraction-fallback.service.ts:24`, `post-event-feedback-extraction-validation.ts:3`, and `post-event-feedback-stop-matcher.spec.ts`.
Done: no importer of the folding functions names a file about opt-out commands.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback`
Do not: change any folding rule. Pure move. In particular do not reconcile it with the admin's `\p{Diacritic}` folding — see Risks.

**WP-15 — `OUTBOX_RELAY_JOB_OPTIONS` in `queue.constants.ts`** · S · deps: WP-03
Files: `infrastructure/queue/queue.constants.ts`, `modules/post-event-feedback/message-outbox-relay.service.ts:64`, `modules/email/email-outbox-relay.service.ts:53`
Both relays deliberately override the producer defaults with the same at-most-once policy (`attempts: 1`, `removeOnComplete/Fail: true`, `stackTraceLimit: 3`). Each call site still spreads its own `jobId`/`delay`.
Verify: `pnpm --filter @join-the-six/backend test` and update `docs/backend/mechanisms/queues.md` in the same commit.
Do not: parameterise it. If either relay later needs its own `attempts`, inline it back.

**WP-16 — Shared test doubles + harness rename** · M · deps: WP-06
Files: rename `post-event-feedback-loop-doubles.harness.ts` → `post-event-feedback-doubles.harness.ts`; import `FakeDatabase`/`FakeAudit`/`FakeParticipants`/`FakeQueue`/`FakeEvents` from it in `post-event-feedback-{extractor.service,materializer.service,simulator.integration,extraction-fallback.service}.spec.ts`; promote the materializer's `FakeQueue` (`:948`, the `delay`-recording superset) into the shared file. Rename `FeedbackTestQueue` → `FakeFeedbackQueue` and `SimulatorFakeRepository` → `FakeSimulatorRepository`.
Done: exactly one `class FakeDatabase` in the module; ~400 lines deleted; update `docs/backend/modules/post-event-feedback-scenarios.md` L1435-1436 and the FakeQueue duplication note at L1560.
Verify: `pnpm docs:check && pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback`
Do not: merge the five `FakeConversations` classes — each models a different slice and merging them builds a god-double. Do not replace `post-event-feedback-extraction-fallback.service.spec.ts:329`'s `FakeDatabase` — it deliberately does not serialise on a promise tail; leave it local and add a comment saying so.

**WP-17 — `phoneE164ToChatJid` → `integrations/wasender`** · S · deps: none
Files: new `integrations/wasender/wasender.jid.ts`; delete `post-event-feedback/feedback-simulator-phone.ts`; update `feedback-simulator.service.ts:763` and inline the copy at `post-event-feedback-loop.harness.ts:1727`.
The reverse (parsing) already lives at `integrations/wasender/wasender.webhook.ts:109`; move it there so one file owns the `<digits>@s.whatsapp.net` shape.
Verify: `pnpm --filter @join-the-six/backend typecheck && pnpm --filter @join-the-six/backend test`
Do not: also move `chatJid` out of the ingress contract. It is legitimately stored for correlation.

**WP-18 — One `estimatePromptTokens`** · S · deps: none
Files: `post-event-feedback-prompt.ts:166-168`, `post-event-feedback-attention-classification.ts:14,139`
Both prompts are `{system, user}`; both compute `Math.ceil((system.length + user.length) / 2.5)` with the divisor declared twice. Keep one in `post-event-feedback-prompt.ts` with the Greek-tokenisation rationale from L156-165; delete `FEEDBACK_ATTENTION_CLASSIFICATION_CHARS_PER_TOKEN`.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback`
Do not: move it to a shared/infra location. It is an extraction-phase judgement, not a neutral utility.

**WP-19 — `--jts-text-2xs` + one `overline` utility** · M · deps: none · **visual change**
Files: `packages/design-tokens/src/tokens.css` (add the missing step(s) below `--jts-text-xs: 0.75rem` at :226); `apps/admin/src/styles/globals.css` (`@utility overline` = the caps recipe at the new size); ~28 call sites currently writing `font-extrabold uppercase tracking-caps text-[0.625|0.65|0.6875|0.7rem]`.
Done: zero arbitrary sub-`xs` `text-[Nrem]` in `apps/admin/src`; `docs/frontend/theming.md` updated in the same commit (AGENTS.md — the token bridge changed).
Verify: `pnpm docs:check && pnpm --filter @join-the-six/admin test && pnpm --filter @join-the-six/admin build`
Do not: introduce a React wrapper component. This is CSS. Do not normalise the other 18 arbitrary `text-[Nrem]` above `xs` in the same commit — four sub-xs values collapsing to one is already a visible ~1px shift on eight screens and needs its own visual pass. Check `apps/admin/test/theme-tokens.spec.ts` still passes — it reads the real `tokens.css`.

**WP-20 — `isRetryableProviderError` → `assistant-models.ts`** · S · deps: none
Files: `modules/assistant/assistant-models.ts`, `modules/assistant/assistant-generation.service.ts:147`, `modules/post-event-feedback/post-event-feedback-extraction.service.ts:359`
Three lines reading the AI SDK retry contract, duplicated. `extraction.service.ts:15` already imports `assistantModelAdapter` from that exact file, so this is not a new layer.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/assistant src/modules/post-event-feedback`
Do not: move the rest of `toGenerationError` — the `failureCause` derivation from `finishReason` is feedback-specific.

**WP-21 — `ParticipantName` component** · S · deps: none
Files: move `apps/admin/src/routes/FeedbackResultsPage.tsx:41-53` → `components/admin/feedback/ParticipantName.tsx`; adopt it at `ConversationDetails.tsx:201` and `:274`.
The D18 rule (render `participantLabel`, italic when `isUnresolvedParticipant`) is currently re-derived in three places.
Verify: `pnpm --filter @join-the-six/admin test`
Do not: add a `docs/frontend/components/*.md` — this is domain UI under `components/admin/feedback/`, not a `Jts*` contract (`docs/frontend/components/README.md:40-43`).

**WP-22 — `assertCleanSimulatorBaseline`** · M · deps: none
File: `feedback-simulator.service.ts`
`startScenarioRun` calls `preflightScenarioRun` at L363 and then re-runs every assertion inline at L412-518 against a second load of the same eight collections. Extract one function that loads and asserts, returning the loaded aggregate; call it from both `:162` and `:335`. ~130 duplicated lines go.
Done: the write-time re-read still happens inside the transaction (the comment at L360-362 explains why); only the assertion text stops being duplicated.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback/post-event-feedback-simulator.integration.spec.ts`
Do not: skip the second read to "avoid the duplicate query". That read is the guarantee.

**WP-23 — Private `listOpenBotConversations` in the feedback conversation repository** · S · deps: none
File: `modules/conversations/feedback-conversation.repository.ts:820-888`
`listOpenDueForReminder` and `listOpenDueForExpiry` differ only by the `reminderCount` `$or` clause; limit bounds, base filter, sort key and parse-back are character-identical. Add one **private** method taking `extraFilter`.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/conversations`
Do not: export it, and do not merge the two doc comments (L809-819, L855-862) — they argue different correctness cases for the same `createdAt` filter. Keep one on each public method.

**WP-24 — Admin: use the generated unions instead of hand-typed ones** · S · deps: none
Files: `apps/admin/src/features/feedback/labels.ts:110,120,130`, `conversationView.ts:21-26`
Import `feedbackConversationDetailDtoOutputGoalsItemStatus`, `...LifecycleState`, `...ControlMode` from `src/api/generated/model/`; delete the hand-written `"pending"|"asked"|"answered"|"skipped"` triplicate; rename `ConversationLike` → `ConversationStatusFields` and type its fields from the generated unions.
Verify: `pnpm --filter @join-the-six/admin typecheck && pnpm --filter @join-the-six/admin test`
Do not: edit anything under `apps/admin/src/api/generated/**`. Import only.

**WP-25 — Reconcile the `design-tokens` build script with AGENTS.md** · S · deps: none
File: `packages/design-tokens/package.json` (and `AGENTS.md:102-105` if the answer is "there is no build")
`build` and `typecheck` are both `node --check scripts/verify-tokens.mjs`, which syntax-checks the verifier and never runs it, while `apps/admin/src/styles/globals.css:28` imports `src/tokens.css` directly through the exports map. Either make `build` execute the verifier, or drop `build` and correct the AGENTS.md sentence.
Verify: `pnpm --filter @join-the-six/design-tokens build && pnpm docs:check`
Do not: introduce a real emit step. Nothing consumes a built artifact.

### Group C — file splits (depend on the extractions that empty them)

**WP-26 — Split `environment.ts` by mechanism** · M · deps: WP-03
Files: `infrastructure/config/environment.ts` (581 → ~380) → new `mongo-connection-string.ts` (L6-104 parser + the production URI rules at L487-533), new `enabled-modules.ts` (L544-581, the five `is*Enabled(NodeJS.ProcessEnv)` readers), new `environment-values.ts` (`emptyStringToUndefined` + `parseUrl`, currently duplicated in `observability-environment.ts:3`).
Done: `validateEnvironment` and `Environment` are still exported from `infrastructure/config/environment.ts` — every `ConfigService<Environment, true>` factory, `app-config.module.ts:4` and `cli/emit-openapi.ts` import from that path.
Verify: `pnpm --filter @join-the-six/backend build && pnpm --filter @join-the-six/backend exec vitest run src/infrastructure/config`
Do not: split the schema per product domain. See Decision 4. Do not move the field-level zod builders (L105-252) — they are cohesive with the schema.

**WP-27 — `assistant-turn-view.ts`** · M · deps: none
Files: `modules/assistant/assistant.service.ts` (1002 → ~790) → new `assistant-turn-view.ts` taking L785-863 (`toThreadView`/`toTurnView`, neither uses `this`) and L866-1002 (ten module-level pure functions).
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/assistant`
Do not: cut L618-774 (the cross-store reconciliation). It needs three injected deps; the wiring cost exceeds the readability gain. Keep the moved `assert*` functions throwing the same `Error` types — `assistant.service.spec.ts` asserts on several messages.

**WP-28 — Move document-shape helpers next to the document schema** · M · deps: WP-23
Files: `modules/conversations/feedback-conversation.repository.ts` (1051 → ~900) → `feedback-conversation.schemas.ts`: move L960-1048 (`feedbackConversationFilter`, `sortTranscript`, `goalStatusRank`, `lowerGoalStatuses`, `messageIdentityKeys`, `assertMessageIdentity`, `exceedsCapacity`) and `feedbackConversationSummarySchema` (L43-88).
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/conversations`
Do not: move `isDuplicateKeyError` — it is a Mongo driver concern and stays in the repository.

**WP-29 — `inbox` view mapping out of the conversation service** · M · deps: WP-04
Files: `post-event-feedback-conversation.service.ts` (821 → ~660) → new sibling holding L662-821 verbatim (`conversationCapabilities`, `toListItem`, `toAnswerView`, `noteOrigin`, `toNoteView`, `displayNameFor`, `deliveryFor`). Zero I/O, zero signature changes.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback/post-event-feedback-conversation.service.spec.ts`
Do not: also move `toDetailView`/`toResultsView` (L557-629) — each does a repository read.

**WP-30 — Pure helpers out of the extractor** · M · deps: WP-11, WP-12, WP-13
Files: `post-event-feedback-extractor.service.ts` (1125 → ~600) → new siblings for `resolveOutbound` (L465-545, the pure four-copy/dedupe-key decision), `resolveGoalStatuses` + `isCompleting` (L908-958), the attention grouping (L960-1027). Rename `resolveSkip` (L347) → `skipOutcome` — it returns a `FeedbackExtractOutcome | undefined`, not a boolean.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback`
Do not: move `reviewBeforeSending` (L547-604) — it does two reads and stays in the service.

**WP-31 — Four pure helpers out of the materializer** · S · deps: WP-12
File: `post-event-feedback-materializer.service.ts` L852-907 → `question-set.ts` (`fitToTranscript` + the campaign-copy resolvers, most of which WP-12 already collapsed). Also move `FEEDBACK_STOP_ACK_DEDUPE_PREFIX` (L66) into `question-set.ts` as `createFeedbackStopAckDedupeKey(conversationId)`, replacing the string concatenation at L460.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback/post-event-feedback-materializer.service.spec.ts`
Do not: split the inbound (L293-401, L694-790) and outbound (L554-692) arms. See Decision 9.

**WP-32 — Split the loop harness in two** · M · deps: WP-06, WP-16
Files: `post-event-feedback-loop.harness.ts` (1902 → ~1050) → new `post-event-feedback-loop-scenario.ts` (L147-545: the scenario and outcome vocabulary; rename `Duration` → `ScenarioDuration` while moving) and `post-event-feedback-loop-model.harness.ts` (L547-975: `ScriptedExtractionModel`, `modelFailure`, `buildProposal`, `resolveCite`, `resolveAttentionCite`).
Done: dependency runs one way — scenario ← model ← harness ← runner. Update `docs/backend/modules/post-event-feedback-scenarios.md` L1435-1436, L1464-1477.
Verify: `pnpm docs:check && pnpm --filter @join-the-six/backend build && pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback`
Do not: lift `drainTo` (L1400-1464) or `FeedbackTestQueue` (L977-1053) out — the former closes over processor and repeatables and has no second caller.

**WP-33 — Simulator run-status split** · M · deps: WP-04, WP-22
File: `feedback-simulator.service.ts` → new sibling holding L589-750 (`getScenarioRun`, pure status derivation) plus its two helpers at L938-1009, renamed to `runStage` / `renderTemplate` / `progressPercent` now the file name carries the prefix.
Verify: `pnpm --filter @join-the-six/backend exec vitest run src/modules/post-event-feedback/post-event-feedback-simulator.integration.spec.ts`
Do not: touch `post-event-feedback-real-model-corpus.ts` — it is imported by production code at `feedback-simulator.service.ts:47,150`.

**WP-34 — `AssistantPage` and `FeedbackInboxPage` pure-code extraction** · M · deps: WP-07
Files: `routes/AssistantPage.tsx` (835 → ~600) → `features/assistant/failureMessages.ts` (L115-147, next to the existing `assistantFailureMessage`) and `features/assistant/composerSettings.ts` (the L82-98 readers plus the L588-604 writers, which currently live 500 lines apart); `routes/FeedbackInboxPage.tsx` (632 → ~500) → `components/admin/feedback/CampaignHeader.tsx` (L391-515 plus the local `CampaignCount` at L78-94), taking the campaign read model and four callbacks.
Verify: `pnpm --filter @join-the-six/admin typecheck && pnpm --filter @join-the-six/admin test`
Do not: extract `executeAction` (`AssistantPage.tsx:228-484`) — it closes over ~8 setters. Do not move the eight mutation handlers out of `FeedbackInboxPage` — they own this screen's query cache and `CampaignHeader` must receive callbacks, not hooks, or the invalidation keys drift. Do not lift the scroll `useLayoutEffect`s (L531-586); their ordering relative to the messages memo is load-bearing and untested.

**WP-35 — Isolate the dev-only simulator table** · S · deps: none
Files: `packages/database/src/schema/post-event-feedback.ts` L467-504 + L518-519 → new `packages/database/src/schema/feedback-sim-outbound.ts`, re-exported from `schema/index.ts`.
Done: `pnpm db:check` reports no new migration — drizzle sees an identical table set.
Verify: `pnpm --filter @join-the-six/database test`
Do not: split campaigns from transport. `messageOutbox.campaignId` is a `notNull` FK to `feedbackCampaigns` (L413-417).

### Group D — folder moves (largest diffs; land last, one per commit, never mixed with behaviour)

**WP-36 — Split `post-event-feedback.repository.ts` per table** · L · deps: WP-29, WP-30, WP-31
File: `post-event-feedback.repository.ts` (1049) → five `@Injectable`s: campaigns + eligible-attendee join (L69-211), answers + notes + the advisory lock at L1040-1048 (L213-473), `provider_message_ingress` (L475-612, L835-854, L1013-1025), `message_outbox` (L614-830, L856-969), `feedback_sim_outbound` (L971-1038). Update `post-event-feedback-{core,http,worker}.module.ts` providers/exports.
Done: every module resolves at runtime — check by booting, not only by typecheck.
Verify: `pnpm --filter @join-the-six/backend build && pnpm --filter @join-the-six/backend test`
Do not: drop the campaign-status read inside `claimOutboxBatch` (L877-930). It calls `findCampaignById` inside its own outbox transaction to enforce the paused-campaign kill switch; the outbox repository must keep that read or take the status as a parameter, or a paused campaign silently re-arms.

**WP-37 — `simulator/` folder** · M · deps: WP-33, WP-36
Move `feedback-simulator.{service,controller,schemas}.ts`, `post-event-feedback-simulator-http.module.ts`, the run-status file from WP-33 and the sim-outbound repository from WP-36 into `post-event-feedback/simulator/`, dropping the prefixes. Most isolated group (dev/staging only, behind three env conditions) — do it first to prove the move recipe.
Verify: `pnpm api:check && pnpm --filter @join-the-six/backend build && pnpm --filter @join-the-six/backend test && pnpm docs:check`
Do not: change a single line of logic, an `@ApiOperation({ operationId })`, an `@ApiTags`, or a DTO import order. Path rewrites only.

**WP-38 — `outbox/` folder** · L · deps: WP-36, WP-37
Move the ten `message-outbox-*` / `feedback-transport` / `*-transport.service` / `feedback-session-pacer` / `feedback-outbound-transcript` / `feedback-outbox-scheduler` files plus the outbox repository into `post-event-feedback/outbox/`. Rename `feedback-outbox-scheduler.service.ts` → `outbox/relay-scheduler.service.ts` (its own constant is already `FEEDBACK_OUTBOX_RELAY_SCHEDULER_ID`).
Verify: same as WP-37.
Do not: let anything outside `outbox/` touch `message_outbox` directly after the move.

**WP-39 — `extraction/` folder** · L · deps: WP-30, WP-36, WP-38
Move the eight extraction files plus the results repository into `post-event-feedback/extraction/`. The point of the folder is the two renames it enables: `post-event-feedback-extraction.service.ts` (class `PostEventFeedbackExtractionModel`, the provider boundary) → `extraction/model.service.ts`, and `post-event-feedback-extractor.service.ts` (the run) → `extraction/extract.service.ts`. Also rename `post-event-feedback-provider-safety.ts` → `extraction/permissive-safety-settings.ts` (it relaxes Gemini thresholds; the current name says the opposite).
Verify: same as WP-37.
Do not: split `extraction/validate-proposal.ts` (formerly `post-event-feedback-extraction-validation.ts`). See Rejected.

**WP-40 — `campaign/`, `ingress/`, `inbox/`, `sweeps/`, `matching/` folders + root cleanup** · L · deps: WP-14, WP-29, WP-36, WP-39
Move the remaining sub-domain files per the target tree. Root keeps `question-set.ts`, `attention.ts`, `jobs.schemas.ts` (renamed from `post-event-feedback.schemas.ts` — its contents are the versioned queue job contract), `metrics.service.ts`, `operator-alert.ts`, `processor.ts`, `{core,http,worker}.module.ts`, the harnesses and the corpus.
Verify: same as WP-37.
Do not: bury `{core,http,worker}.module.ts` in a subfolder — the HTTP/worker process split is the module's most important architectural fact.

**WP-41 — Move `feedback-conversation.*` into `post-event-feedback/`** · L · deps: WP-28, WP-40
Files: `modules/conversations/feedback-conversation.{schemas,repository}.ts` + their two specs → `modules/post-event-feedback/post-event-feedback-conversation.{document,repository}.ts` (folder root — Decision 2). Move `FeedbackConversationRepository` out of `ConversationThreadModule` providers/exports (`conversation-thread.module.ts:9-10`) into the feedback core module. Rename `feedbackConversationMessageSchema` → `feedbackConversationStoredMessageSchema` in the document file to end the collision with the HTTP schema of the same name.
Done: `conversations/` contains only the schema-v1 assistant aggregate; `docs/backend/modules/conversations.md` and `post-event-feedback.md` both updated, with the schema-v1/v2 co-tenancy invariant (both aggregates share `conversation_threads`, discriminated by `schemaVersion` + `purpose`) stated in exactly one place.
Verify: `pnpm docs:check && pnpm --filter @join-the-six/backend build && pnpm --filter @join-the-six/backend test`
Do not: move `conversation-persistence.errors.ts` or `CONVERSATION_THREAD_COLLECTION` — both are genuinely shared. Do not lose the co-tenancy filter; a missed Nest provider surfaces only as a runtime resolution error.

**WP-42 — Wasender: one-way dependency** · M · deps: WP-17, WP-40
Files: `integrations/wasender/wasender.controller.ts` + `wasender-http.module.ts` (+ specs) → `modules/post-event-feedback/ingress/`. Rename what stays: `wasender-transport.module.ts` → `wasender-client.module.ts` (`WasenderClientModule`); the moved module becomes `wasender-webhook.module.ts` (`WasenderWebhookModule`). Move `wasenderCorrelationIdSchema` onto the shared `correlationIdSchema` from WP-09.
Done: `integrations/wasender/` imports no product code; `grep -rn "modules/post-event-feedback" apps/backend/src/integrations` returns nothing.
Verify: `pnpm api:check && pnpm --filter @join-the-six/backend build && pnpm --filter @join-the-six/backend test && pnpm docs:check` — update `docs/backend/mechanisms/wasender.md` in the same commit.
Do not: change the webhook route, its `@ApiOperation({ operationId })` or its `@ApiTags`. If `api:check` diffs, revert and report — do not commit a regenerated client.

## Execution contract for implementing agents

### Dispatch and routing

Packets go one at a time to a Cursor CLI model, in the same working tree. They are **not** run
concurrently: the Group A packets own disjoint files, but two agents sharing one tree still collide
on `pnpm format`, the turbo cache and each other's half-finished builds. The implementing agent
never commits — it leaves the tree dirty, and the orchestrator reviews the diff, re-runs the
verification and commits.

The reason a cheap model is safe on most of this is that **the naming decisions are not delegated**.
Every name a packet introduces is already fixed in the packet text, chosen during synthesis. The
implementing agent types the decided name; it does not invent one. A packet that would force an
agent to name something itself is an incomplete packet — it comes back here to be finished.

| Model                  | Gets                                          | Why                                                              |
| ---------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `composer-2.5`         | WP-00, WP-01, WP-02, WP-05                    | Explicit symbol lists, no type traps, nothing to decide          |
| `cursor-grok-4.5-high` | WP-03, WP-04, WP-06, WP-0B, Group B/C backend | TS4023 traps, harness surgery, infra wiring — judgement required |
| Opus 5 (max reasoning) | WP-19, every admin packet in Group C          | Visual work, and `apps/admin/src` has no test net                |

Order: Group A (WP-01 → WP-06) → WP-00 → WP-0B → Group B → Group C → Group D.

- **Read `AGENTS.md` before touching anything.** Docs are part of the implementation: update
  `docs/` in the **same commit** whenever the change touches architecture, ownership, runtime
  boundaries, a job/retry contract, configuration, or a component contract. `pnpm docs:check`
  validates that every markdown link resolves — a moved source file breaks it immediately.
- **`apps/admin/src/api/generated/**` is never edited, split, reorganised or hand-trimmed.** It is
  orval output. Import from it; that is all. After WP-0B it is generated at build time and no longer
  tracked — which does not soften this rule, it only means a stray edit disappears on the next build
  instead of surviving in a diff.
- **`apps/backend/openapi/openapi.json` is generated, not retyped.** `pnpm api:check` runs inside
  `pnpm check` and fails on drift. If a packet produces an unexpected diff, stop and report — do not
  regenerate to make the check pass.
- **A symbol a spec imports is not an over-export.** The census separates "referenced nowhere else"
  from "referenced only by tests", and a de-export packet may only take the first kind. A pure
  function with its own describe block is legitimately exported; dropping that export to satisfy a
  count breaks the spec, and specs may not be edited to make a de-export packet pass. Grep the whole
  repo including `*.spec.ts` before dropping any `export` — if a spec imports it, take it out of the
  packet and report it. WP-03 shipped with this mistake and was correctly refused by its agent.
- **A type used in an exported signature cannot be unexported.** `declaration: true` over
  `src/**/*.ts` makes that TS4023 — at build, not at typecheck. This applies to every packet, not
  just the ones whose text repeats it.
- **Code taste.** Simple and dumb beats clever. No `Manager`, `Helper`, `Utils`, `Handler`,
  `Processor`, `Base*`, `*Impl`, `Abstract*` as the meaning-carrying part of a name; equally, no
  hyper-concrete names restating the whole call chain. An extraction needs **two real existing call
  sites** or a genuinely unreadable file — "might be reused later" is not a reason. Prefer moving
  code to where it is used over inventing a shared layer.
- **One packet, one commit.** Never mix a folder move with a behaviour change; the move must be
  path rewrites only, verifiable by `git diff --stat` showing renames and imports.

### The two packet classes

Every packet is one of these. Mixing them in a commit is the single most likely way this campaign
breaks something, because the proof for one does not cover the other.

**MOVE** — deletions, dropped `export` keywords, renames, file moves, extractions of an unchanged
function body. The moved code is **byte-identical**; only its location and the import lines change.
The compiler is the proof, so MOVE packets are allowed **anywhere, including files with no tests**.
If `git diff -M` does not show the moved block as a rename or an identical body, a rewrite is hiding
inside a move — stop and split the packet.

**SIMPLIFY** — the code itself changes: merging divergent copies, collapsing branches, reshaping a
function. Tests are the only proof, so a SIMPLIFY packet is permitted **only on files with covering
tests** (read the WP-00 table). Where coverage is zero the packet is blocked until a characterization
test lands as its own packet first. `apps/admin/src` has **0 spec files** — every admin packet here
is MOVE unless it brings its own test.

### What proves each class

| Packet class           | Proof                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- |
| delete / drop `export` | `typecheck` + `build` (TS4023 appears only at build)                                    |
| move / rename          | `git diff -M` shows the rename; imports are the only edited lines                       |
| extraction             | the extracted body is a byte-move; call sites are the only other change                 |
| file split             | the module's own spec files, unchanged                                                  |
| folder move            | `pnpm api:check` — a byte-identical `openapi.json` proves the HTTP surface did not move |
| any SIMPLIFY           | the covering tests named in the packet                                                  |
| harness change         | every `*.spec.ts` file stays byte-identical                                             |

### Invariants every commit must hold

- **796 passing tests across 107 files** — backend 671/94, admin 104/9, database 21/4. No number
  drops and none silently rises. A packet that changes a test count, or changes what a spec
  **asserts** without declaring it, is out of scope — revert it. Updating a spec's import path or a
  renamed identifier is not that: it is mechanical, expected when a packet moves something a spec
  reads, and preferable to the alternative. WP-18 shipped an
  `export { estimatePromptTokens as estimateFeedbackExtractionTokens }` alias purely to avoid editing
  one import line in `post-event-feedback-extraction-eval.spec.ts`; the alias was removed in review,
  because a permanent compatibility shim is a worse outcome than a one-line import change. The
  baseline was 791 at `b773211`; WP-05 deliberately
  deleted one test, WP-07 deliberately added three (`api-error-message.spec.ts`), and the queue
  shutdown fix added three more (`queue-lifecycle.service.spec.ts`) — that last one is not a packet,
  it is the repair of an intermittent failure that was making this very invariant unreadable. A test
  count may only change this way: declared, and recorded here in the same commit that changes it.
- **The suite is now deterministic.** Before `0094ae6`, roughly one backend run in six exited
  non-zero with every assertion passing, because a BullMQ producer connection could be closed
  mid-handshake during teardown. While that was true, a red gate proved nothing and a green gate
  proved less. If random failures reappear, stop dispatching packets and fix them first.
- **`pnpm test` stays under ~25s and needs no Docker.** If a packet makes the suite need infra,
  it is the wrong packet.
- **Net lines go down.** Close every packet with `git diff --shortstat`. A positive net is only
  acceptable when the packet adds tests. An extraction that does not delete a duplicate is not
  reuse — it is one more file, and it should have been rejected.
- **Run `pnpm format` before handoff.** `format:check` is the first phase of `pnpm check` and it
  covers markdown, so an unformatted plan or doc edit fails the gate before a single test runs.
  This is the cheapest possible way to waste a packet.

### Campaign targets (baseline measured 2026-07-26)

| Measure                              | Now                      | What the packets actually deliver |
| ------------------------------------ | ------------------------ | --------------------------------- |
| handwritten source (excl. generated) | 63,641 lines / 327 files | ~1.5% lower — see the note below  |
| files ≥ 1000 lines                   | 9                        | 0                                 |
| files ≥ 500 lines                    | 34                       | ≤ 10                              |
| largest file                         | 1,902                    | ~900                              |
| exports no other file reads          | 332                      | ≤ 30                              |
| tests                                | 796 green / 107 files    | 796+ green                        |

Two honest corrections to the earlier version of this table.

**Line count was never the disease.** Groups C and D move code without deleting it, and splits add
imports. The real deletions — the duplicated fakes (WP-16), `assertCleanSimulatorBaseline` (WP-22),
seven copies of `errorMessage` (WP-07), three of four copy resolvers (WP-12) — total roughly 800–1,000
lines against 63,641. Judge this campaign on placement, not on volume.

**"Largest file under 600" is not achievable from these packets and is not being chased.** The
packets' own targets land at `feedback-conversation.repository.ts` ~900, `assistant.service.ts` ~790,
`conversation.service.ts` ~660. The loop harness is a deliberate exception at ~1,010: its remainder
after WP-32 is one 637-line factory whose seeding and driver phases share mutable closure state, so
splitting it is SIMPLIFY on test infrastructure that has nothing testing it. The nine files over
1,000 lines still go to zero — that was the complaint worth fixing.

- **Verification.** Run the packet's own command while iterating. Run `pnpm check` before handoff
  for WP-09, WP-19, WP-26, WP-36 and every Group D packet. Backend packets that touch exports must
  run `pnpm --filter @join-the-six/backend build`, not just `typecheck` — `declaration: true` over
  `src/**/*.ts` means TS4023 only appears at build.

## Risks and what to check by hand

1. **Queue defaults are not decoration.** `post-event-feedback-sweep.service.ts:186-190` and
   `post-event-feedback-conversation.service.ts:286-290` restate `queue.module.ts:26-32` but drop
   `jitter: 0.5` and use count-only retention instead of `{age, count}`. Deleting them as
   "redundant" changes retry timing and job retention. Not in any packet above — decide separately,
   or not at all. Related trap: `post-event-feedback-doubles.harness.ts:57` hardcodes
   `FEEDBACK_TEST_DEFAULT_JOB_ATTEMPTS = 5` and will desync silently.
2. **WP-12 is a behaviour change.** Two of the four copy resolvers return the stored snapshot with
   no fallback. Unifying on the merging version changes what a pre-existing campaign sends.
3. **The Greek folding rules already disagree across the app boundary.**
   `apps/admin/src/features/feedback/conversationView.ts:108` folds with `\p{Diacritic}` +
   `toLocaleLowerCase("el")`; the backend uses `\p{M}` + punctuation collapse. The admin comment
   claims they match the STOP matcher (D14). They do not. Do **not** build a shared package to fix
   it — reconcile the rule deliberately or record the divergence in an ADR.
4. **Group D is ~90 files of import rewrite with no safe intermediate state.** 43 spec, harness,
   fixture and corpus files import this module by path. Land each folder packet on its own, rebase
   often, and expect conflict with the in-flight `feat/feedback-loop-remediation` branch.
5. **`claimOutboxBatch`'s cross-table read (WP-36).** The paused-campaign kill switch lives inside
   the outbox transaction. Verify by hand that pausing a campaign still stops delivery.
6. **`withPendingIngress` (`materializer.service.ts:824-841`) has exactly one owner.** No test
   catches a second copy. Re-read the file after WP-31 to confirm nothing duplicated the fence.
7. **`pnpm db:check` after WP-10 and WP-35.** The check constraints at
   `packages/database/src/schema/post-event-feedback.ts:205,274` restate the question keys in SQL a
   third time; do not interpolate the const arrays without confirming no new migration file appears.
8. **The `*Insert` deletions (WP-01) are a published package surface.** Verified against
   `apps/*/src`, `apps/*/test`, `packages/*/src` and `scripts/` — confirm nothing else in the repo
   root or CI imports `@join-the-six/database` types before committing.
9. **WP-19 is visible.** Four sub-`xs` sizes collapse to one; eight screens shift ~1px. Look at
   them.
