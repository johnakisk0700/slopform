#!/usr/bin/env node

/**
 * Multi-campaign burst rehearsal runner.
 *
 * Seeds one finished event per burst campaign (BURST_CAMPAIGNS) with opted-in
 * WhatsApp participants each, launches the campaigns, drives every burst persona
 * (BURST_PERSONAS) concurrently through the
 * simulated inject path, then asserts per-persona expectations and the
 * cross-cutting correctness checks. Writes an HTML report via renderBurstReport.
 *
 * Seed identity (idempotent re-find):
 * - Participants are keyed by `+306900<slot><cc><pp>`; slot 0 is historical.
 * - Events are keyed by the slot-qualified catalogue title (exact match).
 * Re-running must not create a second copy. A prior campaign whose conversations
 * have already left the clean intro-only baseline (any participant message, or
 * any closed conversation) is refused rather than silently continued.
 */

import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { isDeepStrictEqual, promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import {
  buildFinishedEvent,
  readGitRevision,
  writeRunSummary,
} from "./burst-artefacts.mjs";
import { createFeedbackBurstHeaders } from "./feedback-burst-auth.mjs";
import {
  buildFeedbackBurstDeliveryExpectation,
  buildFeedbackBurstLiveGuestExerciseExpectation,
  gradeFeedbackBurstExpectations,
} from "./feedback-burst-expectations.mjs";
import { assessFeedbackBurstIntroReadiness } from "./feedback-burst-intro-readiness.mjs";
import { resolveFeedbackBurstQueueNames } from "./feedback-burst-queues.mjs";
import {
  createFeedbackBurstIdempotencyKey,
  requestFeedbackBurstJson as requestJson,
} from "./feedback-burst-http.mjs";
import {
  assertFeedbackBurstFixtureSlotMode,
  feedbackBurstFailedJobBelongsToSlot,
  feedbackBurstParticipantSeedEmail,
  namespaceFeedbackBurstCatalog,
  resolveFeedbackBurstFixtureSlot,
} from "./feedback-burst-fixture-slot.mjs";
import {
  assertFeedbackBurstLiveGuestCallAllowed,
  assertFeedbackBurstLiveGuestTreatment,
  assertFeedbackBurstQuestionSetVersion,
  assertFeedbackBurstTreatmentAdapter,
  resolveFeedbackBurstLiveGuests,
  resolveFeedbackBurstSeedOnly,
  resolveFeedbackBurstTreatment,
} from "./feedback-burst-paid-models.mjs";
import { summarizeThreadsCost } from "./model-prices.mjs";
import { renderBurstReport } from "./burst-report.mjs";

const execFileAsync = promisify(execFile);

const require = createRequire(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "../packages/database/package.json",
  ),
);
const {
  createDatabase,
  participants,
  feedbackAnswers,
  feedbackNotes,
  feedbackSimOutbound,
  feedbackCampaigns,
  messageOutbox,
  events,
} = await import("../packages/database/dist/index.js");
const { BURST_CAMPAIGNS } =
  await import("../apps/backend/dist/modules/post-event-feedback/burst/burst-scenario.js");
const { BURST_PERSONAS } =
  await import("../apps/backend/dist/modules/post-event-feedback/burst/burst-personas.js");
const burstConversationCount = BURST_PERSONAS.length;
const burstCampaignCount = BURST_CAMPAIGNS.length;
const { and, asc, eq, inArray, or } = require("drizzle-orm");

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const STUB_MODEL_ID = "stub/burst-rehearsal";
const QUIET_WINDOW_MS = 45_000;
const POLL_MS = 3_000;
const INTRO_WAIT_MS = 120_000;
// Thirty minutes, because an explicitly enabled live-guest table sets the floor
// rather than the scripted personas. A script sends its whole conversation as
// fast as the quiet window allows; a live guest waits for the bot, calls a model,
// waits again, and does that up to its turn cap. Two of them already took a run
// from nine minutes to fourteen and a half — inside the old fifteen, but only
// just, and six of them will not be.
//
// Raising it is safe because the deadline was never the real backstop: a run
// where genuinely nothing moves anywhere for sixty seconds is caught by the
// stall detector below and gives back most of the clock.
const DEFAULT_DEADLINE_MS = 30 * 60 * 1_000;
// Input quiescence can still flip after the quiet window with no new messages —
// the rule itself waits `QUIET_WINDOW_MS + 5s` after the last inject. Count
// stalls only once every row is past that, then give up after a few unchanged
// polls. This is deliberately not a product-success verdict: expectation rows
// and queue findings grade what the pipeline produced after inputs went quiet.
// Sixty seconds, not fifteen. The fingerprint covers every conversation, so a
// stall means nothing moved anywhere — but at the tail of a run only one or two
// are left, and both may be inside a single extraction call. A paid model call
// can take half a minute, and calling those two stuck would report a phantom
// exactly like the one this early exit was added to stop chasing. Sixty seconds
// of complete stillness across the whole corpus is a dead system, and it still
// returns fourteen of the fifteen minutes.
const STALL_POLLS = 20;

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** A separate bound for the local model inventing the participant's reply. */
const LIVE_GUEST_MODEL_TIMEOUT_MS = 120_000;
// The bot first waits through the 45 s quiet window and may then queue behind
// other xhigh extractions. Two minutes expired during a healthy paid rehearsal
// before Luna's reply arrived, turning every live persona into a one-line test.
// Ten minutes is a harness observation window, not a product response-time SLO;
// the run-wide deadline and stall detector still stop a dead system.
const LIVE_GUEST_BOT_REPLY_TIMEOUT_MS = 10 * 60_000;
const LIVE_GUEST_POLL_MS = 3_000;

/**
 * The character sheets, by persona id.
 *
 * `seedWorld` walks `catalog.personas` — the HTTP response — so the persona
 * objects the run carries are the *published* shape. That shape names the model
 * improvising a guest and deliberately withholds the sheet, because a character
 * sheet in an API response reads like something a participant said. The sheet
 * therefore has to come from the module, and the id is what joins them.
 *
 * Getting this wrong is silent, which is why it is a lookup and not a field
 * read: `persona.live` was simply `undefined` on the published object, the guest
 * iterated an empty `messages` array, and both of them "finished" instantly
 * having said nothing. No error, no CLI call, no clue in the log.
 */
const liveGuestsById = new Map(
  BURST_PERSONAS.filter((persona) => persona.live).map((persona) => [
    persona.id,
    persona.live,
  ]),
);

/**
 * Everything this module binds with `const` must be declared ABOVE this line.
 *
 * A top-level `await` suspends module evaluation, so every statement below it
 * runs only once `main()` has settled — which means any `const` down there sits
 * in the temporal dead zone for the entire run, and the first function to touch
 * it throws «Cannot access '…' before initialization» after the campaigns are
 * already launched. Function declarations hoist and are safe; bindings are not.
 * Three live-guest constants were declared beside the code that used them and
 * killed a paid run this way. Constants live here; functions live below.
 */
await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  let args;
  let treatment;
  let liveGuestsEnabled;
  let seedOnly;
  let fixtureSlot;
  try {
    args = parseArgs(process.argv.slice(2));
    treatment = resolveFeedbackBurstTreatment(args);
    liveGuestsEnabled = resolveFeedbackBurstLiveGuests(args);
    seedOnly = resolveFeedbackBurstSeedOnly(args, liveGuestsEnabled);
    fixtureSlot = resolveFeedbackBurstFixtureSlot(args["fixture-slot"]);
    assertFeedbackBurstFixtureSlotMode({
      fixtureSlot,
      stubMode: treatment === null,
    });
    assertFeedbackBurstLiveGuestTreatment(liveGuestsEnabled, treatment);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    printUsage();
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    printUsage();
    return;
  }

  const apiBase = String(
    args["api-base"] ??
      process.env.FEEDBACK_SIMULATOR_API_BASE ??
      "http://localhost:4000/api/v1",
  ).replace(/\/+$/u, "");
  const adminBase = String(
    args["admin-base"] ??
      process.env.FEEDBACK_SIMULATOR_ADMIN_BASE ??
      "http://localhost:3000",
  ).replace(/\/+$/u, "");
  const token =
    String(args.token ?? process.env.CLERK_BEARER_TOKEN ?? "").trim() ||
    undefined;
  const tokenFile =
    String(
      args["token-file"] ?? process.env.CLERK_BEARER_TOKEN_FILE ?? "",
    ).trim() || undefined;
  const correlationId = String(
    args["correlation-id"] ?? `feedback-burst-${randomUUID()}`,
  );
  if (!REQUEST_ID_PATTERN.test(correlationId)) {
    throw new Error(
      "--correlation-id must be 1-128 log-safe letters, digits, dots, underscores, or hyphens",
    );
  }
  const headers = createFeedbackBurstHeaders({
    token,
    tokenFile,
    correlationId,
  });

  const paidModel = treatment?.model;
  const stubMode = treatment === null;
  let runConfig = null;
  if (treatment) {
    try {
      runConfig = await resolveTreatmentConfig(treatment);
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
      return;
    }
  }

  const publishedCatalog = await requestJson(
    `${apiBase}/dev/feedback/burst/catalog`,
    { headers },
  );
  const catalog = namespaceFeedbackBurstCatalog(publishedCatalog, fixtureSlot);
  const simulatorCatalog = await requestJson(
    `${apiBase}/dev/feedback/simulator/catalog`,
    { headers },
  );
  const simulatedTransport = {
    mode: simulatorCatalog.activeTransportMode,
    profile: simulatorCatalog.activeSimulatedTransport,
  };
  const providerConversationCount = catalog.personas.filter(
    (persona) => liveGuestsEnabled || !persona.liveModel,
  ).length;
  const liveGuestRun = {
    mode: liveGuestsEnabled ? "cursor_agent" : "deterministic_silence",
    total: liveGuestsById.size,
    substituted: liveGuestsEnabled ? 0 : liveGuestsById.size,
  };

  if (treatment) {
    if (simulatorCatalog.activeModel !== paidModel) {
      console.error(
        `Paid mode requested ${paidModel}, but the running API resolved ${simulatorCatalog.activeModel}.`,
      );
      console.error(
        `Restart both API and worker with FEEDBACK_EXTRACTION_MODEL=${paidModel}; refusing to seed or bill a mislabeled run.`,
      );
      process.exitCode = 2;
      return;
    }
    const runningConfig = {
      reasoningEffort: simulatorCatalog.activeExtractionReasoningEffort,
      replyReasoningEffort: simulatorCatalog.activeReplyReasoningEffort,
      attentionReasoningEffort: simulatorCatalog.activeAttentionReasoningEffort,
      serviceTier: simulatorCatalog.activeServiceTier,
    };
    if (!isDeepStrictEqual(runningConfig, runConfig)) {
      console.error(
        `Paid mode requested controls ${JSON.stringify(runConfig)}, but the running API resolved ${JSON.stringify(runningConfig)}.`,
      );
      console.error(
        "Restart both API and worker with the same FEEDBACK_* model controls; refusing to seed or bill a mislabeled treatment.",
      );
      process.exitCode = 2;
      return;
    }
  }

  if (stubMode) {
    if (catalog.extractionStub !== true) {
      console.error(
        "Stub mode requires FEEDBACK_EXTRACTION_STUB=true on the API/worker.",
      );
      console.error(
        "Restart both with FEEDBACK_EXTRACTION_STUB=true FEEDBACK_SIMULATOR_ENABLED=true TRANSPORT_MODE=simulated.",
      );
      process.exitCode = 2;
      return;
    }
  } else if (catalog.extractionStub === true) {
    console.error(
      "Paid mode was requested but FEEDBACK_EXTRACTION_STUB=true is active.",
    );
    console.error(
      "Restart the API and worker with FEEDBACK_EXTRACTION_STUB=false and FEEDBACK_EXTRACTION_MODEL=" +
        paidModel,
    );
    process.exitCode = 2;
    return;
  }

  if (!catalog.workerRegistered) {
    console.error(
      "No feedback worker is registered in Redis. Start the worker before a burst rehearsal.",
    );
    process.exitCode = 2;
    return;
  }

  if (
    simulatedTransportTreatmentIsActive(simulatedTransport) &&
    !args["confirm-transport-faults"]
  ) {
    console.error("Simulated transport fault treatment not confirmed.");
    console.error(`  transport: ${JSON.stringify(simulatedTransport)}`);
    console.error(
      "Re-run with --confirm-transport-faults, or restart API and worker with the baseline none/0/0ms profile.",
    );
    process.exitCode = 2;
    return;
  }

  if (treatment && !args["confirm-paid-run"] && !seedOnly) {
    console.error("Paid real-model burst rehearsal not confirmed.");
    console.error(`  treatment:      ${treatment.name}`);
    console.error(`  model:          ${paidModel}`);
    console.error(`  fixture slot:   ${fixtureSlot}`);
    console.error(
      `  provider-driven:${String(providerConversationCount).padStart(4, " ")}`,
    );
    console.error(
      `The ${providerConversationCount} personas with testimony can make extraction, attention-classification, and conditional reply-rewrite provider calls. The run permanently consumes fixture slot ${fixtureSlot} and leaves all normal persisted outputs in place.`,
    );
    console.error("Re-run with --confirm-paid-run to proceed.");
    process.exitCode = 2;
    return;
  }

  const deadlineMs = positiveInteger(
    args["timeout-ms"] ?? String(DEFAULT_DEADLINE_MS),
    "timeout-ms",
  );
  const databaseUrl = String(process.env.DATABASE_URL ?? "").trim();
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to seed participants");
  }

  const startedAt = new Date();
  const modelLabel = stubMode ? "stub" : paidModel;
  // Paid controls were resolved through the worker's built implementation and
  // matched against the running API before this point. Keep them in every run
  // record: xhigh/high and high/none are different experiments, not trivia.
  console.error(
    seedOnly
      ? "Preparing intro-only burst baseline (no participant or provider calls):"
      : stubMode
        ? "Starting deterministic burst rehearsal (FEEDBACK_EXTRACTION_STUB):"
        : "Starting confirmed paid burst rehearsal:",
  );
  console.error(`  model:          ${modelLabel}`);
  if (treatment) {
    console.error(`  treatment:      ${treatment.name}`);
  }
  console.error(`  conversations:  ${burstConversationCount}`);
  console.error(`  fixture slot:   ${fixtureSlot}`);
  console.error(`  correlation ID: ${correlationId}`);
  console.error(`  deadline:       ${deadlineMs}ms`);
  if (runConfig) {
    console.error(`  controls:       ${JSON.stringify(runConfig)}`);
  }
  console.error(`  transport:      ${JSON.stringify(simulatedTransport)}`);

  console.log(
    JSON.stringify({
      event: "feedback_burst.started",
      model: modelLabel,
      treatment: treatment?.name ?? null,
      config: runConfig,
      transport: simulatedTransport,
      liveGuests: liveGuestRun,
      fixtureSlot,
      correlationId,
      // The catalogue the running API serves, not the constants this script
      // imported. They are the same source compiled twice, and today they
      // disagreed: the API was still serving a `dist` from before a rebuild.
      // Reporting the server's numbers is what makes that visible in the log
      // instead of leaving the run quietly measuring code nobody is running.
      conversationCount: catalog.personas.length,
      campaignCount: catalog.campaigns.length,
      startedAt: startedAt.toISOString(),
    }),
  );

  const client = createDatabase({
    connectionString: databaseUrl,
    applicationName: "feedback-burst-runner",
    maxConnections: 4,
  });

  /** @type {Map<string, {persona: object, participantId: string, eventId?: string, campaignId?: string, conversationId?: string, injected: {text: string | null, at: string}[]}>} */
  const byPersonaId = new Map();
  /** @type {Map<string, {slug: string, title: string, ordinal: number, eventId: string, campaignId: string, personaIds: string[]}>} */
  const byCampaignSlug = new Map();

  try {
    const seeded = await seedWorld({
      db: client.db,
      catalog,
      apiBase,
      headers,
      fixtureSlot,
    });
    for (const row of seeded.personas) {
      byPersonaId.set(row.persona.id, {
        persona: row.persona,
        participantId: row.participantId,
        injected: [],
      });
    }
    for (const campaign of seeded.campaigns) {
      byCampaignSlug.set(campaign.slug, campaign);
      for (const personaId of campaign.personaIds) {
        const entry = byPersonaId.get(personaId);
        if (entry) {
          entry.eventId = campaign.eventId;
        }
      }
    }

    console.error(`Launching ${burstCampaignCount} campaigns…`);
    for (const campaign of seeded.campaigns) {
      const launched = await requestJson(
        `${apiBase}/feedback/campaigns/launch`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({ eventId: campaign.eventId }),
        },
      );
      assertFeedbackBurstQuestionSetVersion(
        launched,
        `launch response for campaign ${launched.id ?? "missing"}`,
      );
      const readBack = await requestJson(
        `${apiBase}/feedback/campaigns/${launched.id}`,
        { headers },
      );
      if (
        readBack.id !== launched.id ||
        readBack.eventId !== campaign.eventId
      ) {
        throw new Error(
          `Campaign read-back did not match launch response for event ${campaign.eventId}`,
        );
      }
      assertFeedbackBurstQuestionSetVersion(
        readBack,
        `campaign read-back ${readBack.id}`,
      );
      campaign.campaignId = launched.id;
      console.error(`  ${campaign.slug}: campaign ${launched.id}`);
    }

    for (const campaign of seeded.campaigns) {
      const listed = await requestJson(
        `${apiBase}/feedback/campaigns/${campaign.campaignId}/conversations`,
        { headers },
      );
      for (const conversation of listed.conversations) {
        const persona = catalog.personas.find(
          (entry) => entry.phoneE164 === conversation.phoneAtLaunch,
        );
        if (!persona) {
          throw new Error(
            `Conversation ${conversation.id} phone ${conversation.phoneAtLaunch} is not a burst persona`,
          );
        }
        const entry = byPersonaId.get(persona.id);
        if (!entry) {
          throw new Error(`Missing seed entry for persona ${persona.id}`);
        }
        entry.campaignId = campaign.campaignId;
        entry.conversationId = conversation.id;
      }
      const missing = campaign.personaIds.filter(
        (id) => !byPersonaId.get(id)?.conversationId,
      );
      if (missing.length > 0) {
        throw new Error(
          `Campaign ${campaign.slug} missing conversations for: ${missing.join(", ")}`,
        );
      }
    }

    console.error("Waiting for current intro outboxes in the simulated sink…");
    await waitForIntros({
      db: client.db,
      targets: [...byPersonaId.values()].map((entry) => ({
        phoneE164: entry.persona.phoneE164,
        conversationId: entry.conversationId,
      })),
      timeoutMs: INTRO_WAIT_MS,
      faultTreatmentActive:
        simulatedTransportTreatmentIsActive(simulatedTransport),
    });

    if (seedOnly) {
      console.log(
        JSON.stringify({
          event: "feedback_burst.seeded",
          model: modelLabel,
          treatment: treatment?.name ?? null,
          config: runConfig,
          transport: simulatedTransport,
          fixtureSlot,
          correlationId,
          campaignCount: seeded.campaigns.length,
          conversationCount: byPersonaId.size,
          seededAt: new Date().toISOString(),
        }),
      );
      console.error(
        "Seed-only baseline ready; no participant messages or provider calls were made.",
      );
      return;
    }

    if (!liveGuestsEnabled && liveGuestsById.size > 0) {
      console.error(
        `Replacing ${liveGuestsById.size} unscripted live guests with deterministic silence; no cursor-agent persona calls will run.`,
      );
    }
    console.error(`Driving ${burstConversationCount} personas concurrently…`);
    const driveStarted = Date.now();
    await Promise.all(
      [...byPersonaId.values()].map((entry) =>
        drivePersona({
          apiBase,
          headers,
          entry,
          correlationId,
          liveGuestsEnabled,
        }),
      ),
    );
    console.error(
      `All injects finished in ${Math.round((Date.now() - driveStarted) / 1000)}s; polling for ingested + quiet inputs…`,
    );

    const deadlineAt = Date.now() + deadlineMs;
    let timedOut = false;
    let gaveUpEarly = false;
    let previousProgressKey = null;
    let unchangedPolls = 0;
    while (true) {
      const snapshot = await collectSnapshot({
        apiBase,
        headers,
        adminBase,
        catalog,
        byPersonaId,
        byCampaignSlug,
        db: client.db,
        liveGuestsEnabled,
      });
      const notIngestedAndQuiet = snapshot.conversations.filter(
        (row) => !row.ingestedAndQuiet,
      );
      const line = `ingested + quiet ${snapshot.conversations.length - notIngestedAndQuiet.length}/${snapshot.conversations.length}${
        notIngestedAndQuiet.length > 0
          ? ` (waiting: ${notIngestedAndQuiet
              .slice(0, 5)
              .map((row) => row.personaId)
              .join(", ")}${notIngestedAndQuiet.length > 5 ? "…" : ""})`
          : ""
      }`;
      console.error(line);
      if (notIngestedAndQuiet.length === 0) {
        break;
      }
      if (Date.now() >= deadlineAt) {
        timedOut = true;
        console.error(
          "Deadline reached before every input was ingested + quiet.",
        );
        break;
      }
      // Fingerprint input-quiescent membership and every conversation's message
      // count. Lifecycle-only thrash without a new message or newly quiescent
      // row is exactly the stuck case this exit is for.
      const progressKey = snapshot.conversations
        .map(
          (row) =>
            `${row.personaId}:${row.ingestedAndQuiet ? "1" : "0"}:${row.messageCount}`,
        )
        .sort()
        .join("|");
      const waitingOnQuiet = notIngestedAndQuiet.some(
        (row) => !row.quietElapsed,
      );
      if (!waitingOnQuiet && progressKey === previousProgressKey) {
        unchangedPolls += 1;
        if (unchangedPolls >= STALL_POLLS) {
          gaveUpEarly = true;
          console.error(
            `Gave up early: no ingestion/quiet progress for ${STALL_POLLS} polls (~${(STALL_POLLS * POLL_MS) / 1_000}s) with nothing in flight.`,
          );
          console.error(
            `Not ingested + quiet: ${notIngestedAndQuiet.map((row) => row.personaId).join(", ")}`,
          );
          break;
        }
      } else {
        unchangedPolls = 0;
        previousProgressKey = progressKey;
      }
      await sleep(POLL_MS);
    }

    const finalSnapshot = await collectSnapshot({
      apiBase,
      headers,
      adminBase,
      catalog,
      byPersonaId,
      byCampaignSlug,
      db: client.db,
      liveGuestsEnabled,
    });

    const findings = [
      ...findDuplicateOutbound(finalSnapshot),
      ...findCrossConversationCitations(finalSnapshot),
      ...findLostParticipantText(finalSnapshot, byPersonaId),
      ...(timedOut || gaveUpEarly
        ? findCampaignsNotTerminal(finalSnapshot, byCampaignSlug, {
            when: gaveUpEarly
              ? "when ingestion/quiet polling gave up early"
              : "at the deadline",
          })
        : []),
      ...(await findFailedJobs(finalSnapshot, fixtureSlot)),
    ];

    if (stubMode) {
      const nonStub = finalSnapshot.conversations.filter(
        (row) =>
          row.observedModel !== null && row.observedModel !== STUB_MODEL_ID,
      );
      if (nonStub.length > 0) {
        findings.push({
          kind: "job_failed",
          detail: `Expected stub/burst-rehearsal but conversations recorded model ${nonStub[0].observedModel}`,
          conversationIds: nonStub.map((row) => row.conversationId),
        });
      }
    } else {
      const wrongModel = finalSnapshot.conversations.filter(
        (row) => row.observedModel !== null && row.observedModel !== paidModel,
      );
      if (wrongModel.length > 0) {
        findings.push({
          kind: "job_failed",
          detail: `Expected ${paidModel} but conversations recorded model ${wrongModel[0].observedModel}`,
          conversationIds: wrongModel.map((row) => row.conversationId),
        });
      }
    }

    const campaignResults = catalog.campaigns.map((campaignDef) => {
      const seededCampaign = byCampaignSlug.get(campaignDef.slug);
      const conversations = finalSnapshot.conversations
        .filter((row) => row.campaignSlug === campaignDef.slug)
        .map((row) =>
          toConversationResult(row, {
            stubMode,
            adminBase,
            campaignId: seededCampaign.campaignId,
          }),
        );
      return {
        slug: campaignDef.slug,
        title: campaignDef.title,
        campaignId: seededCampaign.campaignId,
        eventId: seededCampaign.eventId,
        status: finalSnapshot.campaignStatusById.get(seededCampaign.campaignId),
        adminUrl: `${adminBase}/admin/feedback/${encodeURIComponent(seededCampaign.campaignId)}`,
        conversations,
      };
    });

    const finishedAt = new Date();
    const anyConversationFailed = campaignResults.some((campaign) =>
      campaign.conversations.some((conversation) => !conversation.passed),
    );
    const campaignIds = [...byCampaignSlug.values()].map(
      (campaign) => campaign.campaignId,
    );
    // Token/cost come from the API process's MongoDB, not whichever database
    // happens to be in the runner's local .env. Usage may be absent on older
    // data — report null ("unavailable"), never invent 0.
    const { tokenUsage, costUsd: runCostUsd } = await readRunTokenCost({
      apiBase,
      headers,
      campaignIds,
    });
    const result = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      model: modelLabel,
      treatment: treatment?.name ?? null,
      config: runConfig,
      transport: simulatedTransport,
      liveGuests: liveGuestRun,
      fixtureSlot,
      passed: !anyConversationFailed && findings.length === 0,
      campaigns: campaignResults,
      findings,
      tokenUsage,
      costUsd: runCostUsd,
    };

    const reportDirectory = path.join(repositoryRoot, "report");
    await mkdir(reportDirectory, { recursive: true });
    const stamp = finishedAt
      .toISOString()
      .replaceAll(":", "-")
      .replace(/\.\d{3}Z$/u, "Z");
    const reportPath = path.join(
      reportDirectory,
      `feedback-burst-${stamp}.html`,
    );
    await writeFile(reportPath, renderBurstReport(result), "utf8");

    // The same event that goes to stdout also goes to disk beside the HTML, and
    // that copy is tracked in git. The HTML is the thing an operator reads once;
    // the JSON is what the next run is compared against, and `report/` was
    // ignored wholesale until sixteen runs of evidence turned out to exist on
    // exactly one laptop. `burst-artefacts.mjs` owns the shape so that the last
    // step of a paid run is covered by tests rather than by hope.
    const finishedEvent = buildFinishedEvent({
      result,
      stamp,
      reportPath: path.relative(repositoryRoot, reportPath),
      revision: await readGitRevision(repositoryRoot),
    });
    await writeRunSummary({
      directory: reportDirectory,
      stamp,
      event: finishedEvent,
    });

    console.log(JSON.stringify(finishedEvent));
    console.error(formatCostLine(tokenUsage, runCostUsd));
    console.error(reportPath);
    process.exitCode = result.passed ? 0 : 1;
  } finally {
    await client.pool.end().catch(() => undefined);
  }
}

/**
 * Seed participants through Drizzle, events/attendance through the staff HTTP
 * surface. Participants use the selected reserved phone slot; events use the
 * corresponding slot-qualified catalogue titles. See file header for the
 * idempotency rules.
 */
async function seedWorld({ db, catalog, apiBase, headers, fixtureSlot }) {
  const personaRows = [];
  for (const persona of catalog.personas) {
    const participantId = await upsertBurstParticipant(
      db,
      persona,
      fixtureSlot,
    );
    personaRows.push({ persona, participantId });
  }

  const campaigns = [];
  for (const campaign of catalog.campaigns) {
    const campaignPersonas = personaRows.filter(
      (row) => row.persona.campaign === campaign.slug,
    );
    const eventId = await ensureFinishedEvent({
      db,
      apiBase,
      headers,
      campaign,
      campaignPersonas,
    });
    for (const row of campaignPersonas) {
      await addAttendeeIfAbsent({
        apiBase,
        headers,
        eventId,
        participantId: row.participantId,
      });
    }
    campaigns.push({
      slug: campaign.slug,
      title: campaign.title,
      ordinal: campaign.ordinal,
      eventId,
      campaignId: "",
      personaIds: campaignPersonas.map((row) => row.persona.id),
    });
  }

  return { personas: personaRows, campaigns };
}

async function upsertBurstParticipant(db, persona, fixtureSlot) {
  const email = feedbackBurstParticipantSeedEmail(persona, fixtureSlot);
  const existing = await db
    .select()
    .from(participants)
    .where(
      or(
        eq(participants.phoneE164, persona.phoneE164),
        eq(participants.emailNormalized, email),
      ),
    )
    .limit(2);
  if (existing.length > 1) {
    throw new Error(
      `Fixture phone ${persona.phoneE164} and email ${email} resolve to different participants; refuse to merge identities`,
    );
  }
  if (existing[0]) {
    const row = existing[0];
    // The email is the seat; the name is whichever persona currently sits in
    // it. Retiring a persona and seating a new one on the same phone is an
    // ordinary catalogue change — it happened the first time a row was replaced
    // — and refusing it left an orphan that blocked every later run with a
    // message about a participant nobody could find. A *different* email on a
    // reserved phone is the case this guard is really for, and still refuses.
    if (row.phoneE164 !== persona.phoneE164) {
      throw new Error(
        `Fixture email ${email} already belongs to participant ${row.id} on another phone; refuse to overwrite`,
      );
    }
    if (row.emailNormalized !== email) {
      throw new Error(
        `Reserved phone ${persona.phoneE164} already belongs to a different participant (${row.id}); refuse to overwrite`,
      );
    }
    if (row.preferredName !== persona.displayName) {
      console.error(
        `  reseating ${persona.phoneE164}: "${row.preferredName}" → "${persona.displayName}"`,
      );
      await db
        .update(participants)
        .set({ preferredName: persona.displayName, updatedAt: new Date() })
        .where(eq(participants.id, row.id));
    }
    if (!row.postEventFeedbackWhatsappOptIn) {
      // Column defaults to false; force opt-in on the reserved seed row.
      await db
        .update(participants)
        .set({
          postEventFeedbackWhatsappOptIn: true,
          updatedAt: new Date(),
        })
        .where(eq(participants.id, row.id));
    }
    return row.id;
  }

  const [inserted] = await db
    .insert(participants)
    .values({
      preferredName: persona.displayName,
      emailNormalized: email,
      phoneE164: persona.phoneE164,
      ageBand: "25_34",
      preferredNeighborhood: "pangrati",
      conversationStyle: 3,
      // Defaults false in schema; set true so launch eligibility passes without
      // a separate updateParticipantFeedbackOptIn round-trip.
      postEventFeedbackWhatsappOptIn: true,
    })
    .returning();
  if (!inserted) {
    throw new Error(`Failed to insert participant for ${persona.id}`);
  }
  return inserted.id;
}

async function ensureFinishedEvent({
  db,
  apiBase,
  headers,
  campaign,
  campaignPersonas,
}) {
  const existingEvents = await db
    .select()
    .from(events)
    .where(eq(events.title, campaign.title))
    .orderBy(asc(events.createdAt));

  for (const event of existingEvents) {
    const campaignRow = await db
      .select()
      .from(feedbackCampaigns)
      .where(eq(feedbackCampaigns.eventId, event.id))
      .limit(1);
    if (campaignRow[0]) {
      assertFeedbackBurstQuestionSetVersion(
        campaignRow[0],
        `reused campaign ${campaignRow[0].id}`,
      );
      await assertReusableCampaign(apiBase, headers, campaignRow[0].id);
      if (event.status !== "finished") {
        throw new Error(
          `Burst event ${event.id} for "${campaign.title}" has a campaign but status ${event.status}`,
        );
      }
      await ensureEventVenue({ apiBase, headers, campaign, eventId: event.id });
      return event.id;
    }
  }

  if (existingEvents.length > 0) {
    const event = existingEvents.at(-1);
    await finishEventIfNeeded(apiBase, headers, event);
    await ensureEventVenue({ apiBase, headers, campaign, eventId: event.id });
    return event.id;
  }

  const created = await requestJson(`${apiBase}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      title: campaign.title,
      startsAt: new Date(Date.now() - 24 * 60 * 60 * 1_000).toISOString(),
      venue: campaign.venue,
    }),
  });
  assertExactEventVenue(campaign, created.venue);
  // draft → scheduled → finished; draft → finished is illegal.
  await requestJson(`${apiBase}/events/${created.id}/status`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "scheduled" }),
  });
  await requestJson(`${apiBase}/events/${created.id}/status`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "finished" }),
  });
  return created.id;
}

/**
 * Canonicalize a reused event through the staff HTTP boundary before launch.
 *
 * Venue replacement is whole-object and finished events allow venue-only
 * patches. Reading first avoids bumping `contextRevision` on every rehearsal;
 * validating the PATCH response makes persistence drift a pre-launch failure
 * instead of silently changing what the extraction model is being graded on.
 */
async function ensureEventVenue({ apiBase, headers, campaign, eventId }) {
  const detail = await requestJson(`${apiBase}/events/${eventId}`, { headers });
  if (eventVenueMatches(campaign.venue, detail.venue)) {
    assertExactEventVenue(campaign, detail.venue);
    return;
  }

  console.error(`  ${campaign.slug}: correcting venue on event ${eventId}`);
  const updated = await requestJson(`${apiBase}/events/${eventId}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ venue: campaign.venue }),
  });
  assertExactEventVenue(campaign, updated.venue);
}

function eventVenueMatches(expected, actual) {
  if (
    actual === null ||
    typeof actual !== "object" ||
    !Number.isSafeInteger(actual.contextRevision) ||
    actual.contextRevision <= 0
  ) {
    return false;
  }
  const { contextRevision: _contextRevision, ...snapshot } = actual;
  return isDeepStrictEqual(snapshot, expected);
}

function assertExactEventVenue(campaign, actual) {
  if (!eventVenueMatches(campaign.venue, actual)) {
    throw new Error(
      `Burst event "${campaign.title}" did not persist its canonical venue exactly (expected ${JSON.stringify(campaign.venue)}, received ${JSON.stringify(actual)})`,
    );
  }
}

async function finishEventIfNeeded(apiBase, headers, event) {
  if (event.status === "finished") {
    return;
  }
  if (event.status === "cancelled") {
    throw new Error(
      `Burst event ${event.id} is cancelled; create a fresh database or rename the prior title`,
    );
  }
  // Legal graph is draft → scheduled → finished; draft → finished is refused.
  if (event.status === "draft") {
    await requestJson(`${apiBase}/events/${event.id}/status`, {
      method: "POST",
      headers,
      body: JSON.stringify({ status: "scheduled" }),
    });
  }
  await requestJson(`${apiBase}/events/${event.id}/status`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "finished" }),
  });
}

async function addAttendeeIfAbsent({
  apiBase,
  headers,
  eventId,
  participantId,
}) {
  try {
    await requestJson(`${apiBase}/events/${eventId}/attendees`, {
      method: "POST",
      headers,
      body: JSON.stringify({ participantId, tableNo: 1, present: true }),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/already an attendee|409/iu.test(message)) {
      return;
    }
    throw error;
  }
}

async function assertReusableCampaign(apiBase, headers, campaignId) {
  const listed = await requestJson(
    `${apiBase}/feedback/campaigns/${campaignId}/conversations`,
    { headers },
  );
  for (const conversation of listed.conversations) {
    if (conversation.lifecycle.state === "closed") {
      throw new Error(
        `Prior burst campaign ${campaignId} already has closed conversation ${conversation.id}; refuse to reuse a finished run (the script never cleans up)`,
      );
    }
    const detail = await requestJson(
      `${apiBase}/feedback/campaigns/${campaignId}/conversations/${conversation.id}`,
      { headers },
    );
    const participantMessages = detail.messages.filter(
      (message) => message.actor === "participant",
    );
    if (participantMessages.length > 0) {
      throw new Error(
        `Prior burst campaign ${campaignId} conversation ${conversation.id} already has participant traffic; refuse to silently continue a half-finished run`,
      );
    }
  }
}

async function waitForIntros({ db, targets, timeoutMs, faultTreatmentActive }) {
  const conversationIds = targets.map((target) => target.conversationId);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const introRows = await db
      .select()
      .from(messageOutbox)
      .where(
        and(
          eq(messageOutbox.kind, "intro"),
          inArray(messageOutbox.conversationId, conversationIds),
        ),
      );
    const outboxIds = introRows.map((row) => row.id);
    const sinkRows =
      outboxIds.length === 0
        ? []
        : await db
            .select({ outboxId: feedbackSimOutbound.outboxId })
            .from(feedbackSimOutbound)
            .where(inArray(feedbackSimOutbound.outboxId, outboxIds));
    const readiness = assessFeedbackBurstIntroReadiness({
      targets,
      introRows,
      sinkRows,
    });
    if (readiness.ready) {
      return;
    }
    if (readiness.terminal.length > 0) {
      const details = readiness.terminal
        .map((row) => `${row.phoneE164}:${row.reason}`)
        .join(", ");
      const baselineHint = faultTreatmentActive
        ? " Seed an intro-only baseline under none/0/0ms, stop every feedback worker, then restart API and workers with the intended fault profile."
        : "";
      throw new Error(
        `Current intro outbox reached a terminal state: ${details}.${baselineHint}`,
      );
    }
    if (Date.now() >= deadline) {
      const details = readiness.pending
        .map((row) => `${row.phoneE164}:${row.reason}`)
        .join(", ");
      throw new Error(
        `Timed out waiting for current intro delivery. Pending: ${details}`,
      );
    }
    await sleep(2_000);
  }
}

/**
 * Ask a model for one WhatsApp message, in character, given the transcript.
 *
 * Run with `cwd` outside the repository and told to use no tools: this is a
 * one-shot generation, and an agent that starts exploring a codebase turns a
 * two-second call into a two-minute one. If that happens, the prompt is wrong
 * rather than the model.
 */
async function askLiveGuest({ live, transcript, liveGuestCallsConfirmed }) {
  // Keep the spend gate adjacent to the process invocation. The caller also
  // excludes live personas by default, but that is orchestration; this is the
  // fail-closed boundary if a future refactor reaches this function directly.
  assertFeedbackBurstLiveGuestCallAllowed(liveGuestCallsConfirmed);
  const prompt = [
    live.character,
    "",
    "Η συνομιλία μέχρι τώρα:",
    transcript,
    "",
    "Γράψε ΜΟΝΟ το επόμενο μήνυμα που στέλνεις εσύ, ως κείμενο, τίποτα άλλο.",
    "Χωρίς εισαγωγικά, χωρίς εξηγήσεις, χωρίς όνομα αποστολέα, χωρίς εργαλεία.",
    "Ένα μήνυμα WhatsApp, όπως θα το έγραφες στο κινητό.",
  ].join("\n");

  const { stdout } = await execFileAsync(
    "cursor-agent",
    ["--model", live.model, "--force", "--print", prompt],
    {
      cwd: tmpdir(),
      maxBuffer: 1_000_000,
      timeout: LIVE_GUEST_MODEL_TIMEOUT_MS,
    },
  );
  // Models like to wrap a line in quotes or prefix it with the character's
  // name however plainly they are asked not to; strip both rather than inject
  // «Μάκης: "…"» as though a participant had typed it.
  return stdout
    .trim()
    .replace(/^(?:[^\s:]{1,20}:\s*)/u, "")
    .replace(/^["«'`]+|["»'`]+$/gu, "")
    .trim();
}

/**
 * Drive a guest whose messages nobody wrote: wait for the bot, read what it
 * said, ask the model for a reply, inject it, repeat.
 *
 * The turn cap is what makes the run terminate. A live guest will chat happily
 * past the end of the questionnaire, and a conversation that never goes quiet
 * fails the harness's input-quiescence bound for its whole campaign.
 *
 * The cap is not the only exit, and it used to be. The bot's closing message is
 * itself a new bot turn, so a guest that only watches for one answers it — into
 * a conversation the application has already closed. In run 9 that raised
 * `post_closure_message` against five of the six guests: correct product
 * behaviour, reacting to a message the rehearsal had no business sending. Worse,
 * whatever turns were left over then waited out the full per-turn timeout each,
 * which is what made the live table the longest part of the run.
 *
 * So the lifecycle is read once per turn, after a new bot message appears and
 * before it is answered. That is the only point where the check can prevent the
 * message rather than merely regret it.
 */
async function driveLiveGuest({
  apiBase,
  headers,
  entry,
  live,
  correlationId,
  liveGuestCallsConfirmed,
}) {
  const { persona } = entry;
  let lastSeenBotCount = 0;

  for (let turn = 0; turn < live.maxTurns; turn += 1) {
    const waitUntil = Date.now() + LIVE_GUEST_BOT_REPLY_TIMEOUT_MS;
    let messages = [];
    let botCount = 0;
    // Wait for a bot turn we have not answered yet.
    for (;;) {
      const thread = await requestJson(
        `${apiBase}/dev/feedback/simulator/thread?phoneE164=${encodeURIComponent(persona.phoneE164)}`,
        { headers },
      );
      messages = thread.messages ?? [];
      botCount = messages.filter(
        (message) => message.direction === "outbound",
      ).length;
      if (botCount > lastSeenBotCount) {
        break;
      }
      if (Date.now() >= waitUntil) {
        console.error(
          `${persona.id}: no new bot message for ${Math.round(LIVE_GUEST_BOT_REPLY_TIMEOUT_MS / 1000)}s — the guest stops here.`,
        );
        return;
      }
      await sleep(LIVE_GUEST_POLL_MS);
    }
    lastSeenBotCount = botCount;

    // The message we just saw may be the one that closed the conversation.
    // Answering it would be the rehearsal manufacturing a `post_closure_message`
    // out of nothing, so the guest leaves the same way a person does when the
    // other side has said goodbye.
    const detail = await requestJson(
      `${apiBase}/feedback/campaigns/${entry.campaignId}/conversations/${entry.conversationId}`,
      { headers },
    );
    if (detail.lifecycle.state !== "open") {
      console.error(
        `${persona.id}: the conversation closed (${detail.lifecycle.reason ?? "no reason"}) — the guest stops here with ${live.maxTurns - turn} turn(s) unused.`,
      );
      return;
    }

    const transcript = messages
      .map(
        (message) =>
          `${message.direction === "outbound" ? "BOT" : "ΕΣΥ"}: ${message.text ?? "(χωρίς κείμενο)"}`,
      )
      .join("\n");

    let text;
    try {
      text = await askLiveGuest({
        live,
        transcript,
        liveGuestCallsConfirmed,
      });
    } catch (error) {
      console.error(
        `${persona.id}: the model did not answer (${error.message}) — the guest stops here.`,
      );
      return;
    }
    if (!text) {
      console.error(`${persona.id}: empty reply — the guest stops here.`);
      return;
    }

    await requestJson(
      `${apiBase}/dev/feedback/simulator/inject`,
      {
        method: "POST",
        headers: {
          ...headers,
          "x-request-id": `${correlationId}-${persona.id}-${randomUUID().slice(0, 8)}`,
        },
        body: JSON.stringify({
          phoneE164: persona.phoneE164,
          text,
          fromMe: false,
          idempotencyKey: createFeedbackBurstIdempotencyKey({
            correlationId,
            personaId: persona.id,
            messageIndex: turn,
          }),
        }),
      },
      { transientRetries: 3 },
    );
    entry.injected.push({ text, at: new Date().toISOString() });
    console.error(`${persona.id} (${live.model}): ${text}`);
  }
}

async function drivePersona({
  apiBase,
  headers,
  entry,
  correlationId,
  liveGuestsEnabled,
}) {
  const { persona } = entry;
  const live = liveGuestsById.get(persona.id);
  if (live && liveGuestsEnabled) {
    return driveLiveGuest({
      apiBase,
      headers,
      entry,
      live,
      correlationId,
      liveGuestCallsConfirmed: liveGuestsEnabled,
    });
  }
  // Live personas have no recorded messages by design. In the safe default
  // they therefore become deterministic silence: the intro remains observable,
  // no extraction is scheduled for them, and no external persona model runs.
  for (const [messageIndex, message] of persona.messages.entries()) {
    if (message.afterMs > 0) {
      await sleep(message.afterMs);
    }
    // `text: null` is a voice note, photo or reaction. It travels through the
    // same inject route — the point of the persona who sends them is that the
    // ordinary path is what decides they cannot become testimony.
    await requestJson(
      `${apiBase}/dev/feedback/simulator/inject`,
      {
        method: "POST",
        headers: {
          ...headers,
          "x-request-id": `${correlationId}-${persona.id}-${randomUUID().slice(0, 8)}`,
        },
        body: JSON.stringify({
          phoneE164: persona.phoneE164,
          text: message.text ?? null,
          fromMe: false,
          idempotencyKey: createFeedbackBurstIdempotencyKey({
            correlationId,
            personaId: persona.id,
            messageIndex,
          }),
        }),
      },
      { transientRetries: 3 },
    );
    entry.injected.push({
      text: message.text ?? null,
      at: new Date().toISOString(),
    });
  }
}

async function collectSnapshot({
  apiBase,
  headers,
  adminBase,
  catalog,
  byPersonaId,
  byCampaignSlug,
  db,
  liveGuestsEnabled,
}) {
  const campaignStatusById = new Map();
  const conversations = [];
  const messageOwner = new Map();

  for (const campaign of byCampaignSlug.values()) {
    const campaignView = await requestJson(
      `${apiBase}/feedback/campaigns/${campaign.campaignId}`,
      { headers },
    );
    campaignStatusById.set(campaign.campaignId, campaignView.status);

    for (const personaId of campaign.personaIds) {
      const entry = byPersonaId.get(personaId);
      const persona = entry.persona;
      const detail = await requestJson(
        `${apiBase}/feedback/campaigns/${campaign.campaignId}/conversations/${entry.conversationId}`,
        { headers },
      );
      const results = await requestJson(
        `${apiBase}/feedback/campaigns/${campaign.campaignId}/conversations/${entry.conversationId}/results`,
        { headers },
      );
      const participant = await requestJson(
        `${apiBase}/participants/${entry.participantId}`,
        { headers },
      );
      const thread = await requestJson(
        `${apiBase}/dev/feedback/simulator/thread?phoneE164=${encodeURIComponent(persona.phoneE164)}`,
        { headers },
      );
      const noteRows = await db
        .select()
        .from(feedbackNotes)
        .where(eq(feedbackNotes.conversationId, entry.conversationId));
      const answerRows = await db
        .select()
        .from(feedbackAnswers)
        .where(eq(feedbackAnswers.conversationId, entry.conversationId));

      const flaggedById = new Map(
        noteRows.map((row) => [
          row.id,
          row.extractionMeta?.flaggedForReview === true,
        ]),
      );
      const observedModel =
        answerRows.find((row) => typeof row.extractionMeta?.model === "string")
          ?.extractionMeta?.model ??
        noteRows.find((row) => typeof row.extractionMeta?.model === "string")
          ?.extractionMeta?.model ??
        null;

      for (const message of detail.messages) {
        messageOwner.set(message.id, entry.conversationId);
      }

      const received = thread.messages
        .filter((message) => message.direction === "outbound")
        .map((message) => message.text);
      const transcript = detail.messages
        .filter((message) => message.actor !== "system")
        .map((message) => ({
          seq: message.seq,
          actor: message.actor,
          text: message.text,
          at: message.at,
        }));

      const actual = {
        lifecycle: detail.lifecycle.state,
        closedBecause: detail.lifecycle.reason,
        optedIn: participant.postEventFeedbackWhatsappOptIn === true,
        needsAttention: detail.needsAttention === true,
        answers: results.answers.map((answer) => ({
          question: answer.questionKey,
          about: answer.subjectDisplayName,
          value: answer.valueInt,
        })),
        notes: results.notes.map((note) => ({
          type: note.noteType,
          text: note.text,
          about: note.subjectDisplayName,
          flagged: flaggedById.get(note.id) === true,
        })),
        // Every extraction run makes propose + classify calls. A forwarded
        // model draft may add a reply rewrite, which this row-level heuristic
        // cannot recover; exact phase counts come from feedback.extract.tokens.
        modelCalls: countModelCalls(answerRows, noteRows),
      };

      const expectations = buildExpectations(persona, actual, received, {
        injectedCount: entry.injected.length,
        liveGuestsEnabled,
      });
      // Text sent after a STOP is deliberately not retained — the campaign
      // keeps metadata only once somebody has opted out, because not storing is
      // reversible and storing is not. Requiring it in the transcript therefore
      // asks for something the product must never do: the run reported
      // `lost_participant_text` for a message we correctly discarded, failed on
      // it, and burned the whole input-quiescence deadline waiting for it to
      // appear.
      //
      // Narrow on purpose. Only `stopped` suppresses retention; a conversation
      // closed as completed or expired still records what arrives afterwards,
      // and a message missing from one of those is a real loss.
      const stoppedAt =
        detail.lifecycle.reason === "stopped" && detail.lifecycle.closedAt
          ? Date.parse(detail.lifecycle.closedAt)
          : undefined;
      const injectCaughtUp = entry.injected.every((injected) => {
        // A bodyless inbound has no transcript representation by design, so
        // waiting for one to appear would never become input-quiescent.
        if (injected.text === null) {
          return true;
        }
        if (stoppedAt !== undefined && Date.parse(injected.at) >= stoppedAt) {
          return true;
        }
        return detail.messages.some(
          (message) =>
            message.actor === "participant" &&
            message.text.trim() === injected.text.trim(),
        );
      });
      const lastInjectAt = entry.injected.at(-1)?.at;
      const quietElapsed =
        !lastInjectAt ||
        Date.now() - Date.parse(lastInjectAt) >= QUIET_WINDOW_MS + 5_000;
      // Settlement is «the system finished digesting what we sent», nothing
      // more: every inject landed and the quiet window has passed. It used to
      // additionally require the conversation to REACH the fixture's expected
      // lifecycle, which quietly redefined every expectation mismatch as a
      // stall: a model that legally ended somewhere else — Χαρά asked the
      // 9δ-mandated question her script could not answer, Πάνος took the S70
      // hostile fork instead of S69 — could never become quiescent, burned the
      // stall detector, and surfaced as `campaign_not_terminal`, the exact
      // finding shape of a dead system. Ten of the first fourteen ledgered runs
      // "FAILED" that way, and the 2026-07-31 corpus audit traced every one of
      // runs 10–12's instances to a fixture, not a stall.
      //
      // The fixture's view survives as `lifecycleDiverged` on the row — an
      // observation to read, exactly like the paid-mode expectation rows —
      // while `campaign_not_terminal` now means what it says: messages or jobs
      // genuinely still in flight when the run gave up.
      const lifecycleDiverged =
        !persona.liveModel &&
        !(
          actual.lifecycle === persona.expect.lifecycle &&
          (persona.expect.lifecycle === "open" ||
            actual.closedBecause === persona.expect.closedBecause)
        );
      const ingestedAndQuiet = injectCaughtUp && quietElapsed;

      conversations.push({
        personaId: persona.id,
        displayName: persona.displayName,
        quirk: persona.quirk,
        mirrors: persona.mirrors,
        phoneE164: persona.phoneE164,
        // Which model improvised this guest, or null for a scripted persona.
        // The report needs it for two reasons: a live conversation is graded on
        // almost nothing, so it would otherwise collapse shut exactly when it is
        // the thing worth reading; and when six guests read alike, the first
        // question is whether they were written by the same model.
        liveModel: persona.liveModel ?? null,
        conversationId: entry.conversationId,
        campaignSlug: campaign.slug,
        campaignId: campaign.campaignId,
        expect: persona.expect,
        expectations,
        received,
        transcript,
        actual,
        detail,
        results,
        answerRows,
        noteRows,
        observedModel,
        messageCount: detail.messages.length,
        quietElapsed,
        ingestedAndQuiet,
        lifecycleDiverged,
        adminBase,
      });
    }
  }

  return { conversations, campaignStatusById, messageOwner };
}

function countModelCalls(answerRows, noteRows) {
  const keys = new Set();
  for (const row of [...answerRows, ...noteRows]) {
    const model = row.extractionMeta?.model;
    const createdAt = row.createdAt?.toISOString?.() ?? String(row.createdAt);
    if (model) {
      keys.add(`${model}:${createdAt}`);
    }
  }
  // Lower bound: propose + classify per extraction run. Conditional reply
  // rewrites are counted from logs, not guessed from result rows.
  return keys.size * 2;
}

/**
 * The graded rows for one conversation.
 *
 * A live guest is graded on almost nothing, and that is the point. Its replies
 * are written by a model at run time, so its lifecycle, its consent, whether it
 * raised the attention flag and every answer it gave are things it decided —
 * not things the application promised. Asserting them makes the report lie in
 * both directions: `unexpected answers` failed for the two guests in run 8
 * purely because they answered the questionnaire, which is what a guest is
 * supposed to do, while `needsAttention: false` would have passed for a guest
 * who disclosed nothing and failed for one who disclosed something real.
 *
 * Six of them would put a dozen such rows in a report whose whole job is to be
 * readable in one screenful, and a reader who learns that red rows are normal
 * stops reading the red rows. So a live guest keeps the one assertion that is
 * genuinely the application's promise — it said something, and it did not flood
 * anybody — and everything else moves to the conversation panel, which already
 * renders the lifecycle, the consent, the attention badge and every recorded
 * answer as observation rather than verdict.
 */
function buildExpectations(
  persona,
  actual,
  received,
  { injectedCount = 0, liveGuestsEnabled = false } = {},
) {
  const { expect } = persona;
  const deliveredRow = buildFeedbackBurstDeliveryExpectation({
    minReceived: expect.minReceived,
    maxReceived: expect.maxReceived,
    liveModel: Boolean(persona.liveModel),
    injectedCount,
    receivedCount: received.length,
  });
  if (persona.liveModel) {
    return liveGuestsEnabled
      ? [
          buildFeedbackBurstLiveGuestExerciseExpectation({ injectedCount }),
          deliveredRow,
        ]
      : [deliveredRow];
  }

  const expectations = [
    {
      label: "lifecycle",
      expected: expect.lifecycle,
      actual: actual.lifecycle,
      passed: actual.lifecycle === expect.lifecycle,
    },
    {
      label: "closedBecause",
      expected: String(expect.closedBecause),
      actual: String(actual.closedBecause),
      passed: actual.closedBecause === expect.closedBecause,
    },
    {
      label: "optedIn",
      expected: String(expect.optedIn),
      actual: String(actual.optedIn),
      passed: actual.optedIn === expect.optedIn,
    },
    {
      label: "needsAttention",
      expected: String(expect.needsAttention),
      actual: String(actual.needsAttention),
      passed: actual.needsAttention === expect.needsAttention,
    },
    deliveredRow,
  ];

  for (const wanted of expect.answers) {
    const match = actual.answers.find(
      (answer) =>
        answer.question === wanted.question &&
        answer.about === wanted.about &&
        answer.value === wanted.value,
    );
    expectations.push({
      label: wanted.about
        ? `${wanted.question} about ${wanted.about}`
        : wanted.question,
      expected: formatAnswer(wanted),
      actual: match
        ? formatAnswer(match)
        : actual.answers
            .filter((answer) => answer.question === wanted.question)
            .map(formatAnswer)
            .join("; ") || "—",
      passed: Boolean(match),
    });
  }

  const unexpected = actual.answers.filter(
    (answer) =>
      !expect.answers.some(
        (wanted) =>
          wanted.question === answer.question &&
          wanted.about === answer.about &&
          wanted.value === answer.value,
      ),
  );
  if (unexpected.length > 0) {
    expectations.push({
      label: "unexpected answers",
      expected: "none",
      actual: unexpected.map(formatAnswer).join("; "),
      passed: false,
    });
  }

  return expectations;
}

function formatAnswer(answer) {
  const about = answer.about ?? "∅";
  const value =
    answer.value === null || answer.value === undefined ? "∅" : answer.value;
  return `${answer.question} about=${about} value=${value}`;
}

function toConversationResult(row, { stubMode, adminBase, campaignId }) {
  const graded = gradeFeedbackBurstExpectations(row.expectations, { stubMode });
  return {
    personaId: row.personaId,
    displayName: row.displayName,
    quirk: row.quirk,
    mirrors: row.mirrors,
    phoneE164: row.phoneE164,
    conversationId: row.conversationId,
    adminUrl: `${adminBase}/admin/feedback/${encodeURIComponent(campaignId)}?conversation=${encodeURIComponent(row.conversationId)}`,
    passed: graded.passed,
    expectations: graded.expectations,
    received: row.received,
    transcript: row.transcript,
    actual: row.actual,
    // The fixture's view of where this conversation should have ended, and
    // whether the run agreed — an observation like every paid-mode expectation
    // row. Settlement no longer waits for this match, so the artefact is the
    // only place the divergence survives.
    expected: {
      lifecycle: row.expect?.lifecycle ?? null,
      closedBecause: row.expect?.closedBecause ?? null,
    },
    lifecycleDiverged: row.lifecycleDiverged ?? false,
  };
}

/**
 * duplicate_outbound: the same body delivered twice to the same phone.
 *
 * How this differs from a legitimate re-ask: each goal's product copy is a
 * distinct body, so a follow-up question never matches a prior send byte-for-
 * byte. Two sim_outbound rows that share both phone and body therefore mean the
 * outbox dedupe fence failed (or a replay sent again), not that the bot asked
 * the next question.
 */
function findDuplicateOutbound(snapshot) {
  /** @type {Map<string, {body: string, conversationIds: Set<string>, count: number}>} */
  const counts = new Map();
  for (const conversation of snapshot.conversations) {
    for (const body of conversation.received) {
      const key = `${conversation.phoneE164}::${body}`;
      const entry = counts.get(key) ?? {
        body,
        conversationIds: new Set(),
        count: 0,
      };
      entry.count += 1;
      entry.conversationIds.add(conversation.conversationId);
      counts.set(key, entry);
    }
  }
  const findings = [];
  for (const [key, entry] of counts) {
    if (entry.count < 2) {
      continue;
    }
    const phone = key.split("::")[0];
    findings.push({
      kind: "duplicate_outbound",
      detail: `Phone ${phone} received the same body ${entry.count} times: ${truncate(entry.body)}`,
      conversationIds: [...entry.conversationIds],
    });
  }
  return findings;
}

function findCrossConversationCitations(snapshot) {
  const findings = [];
  for (const conversation of snapshot.conversations) {
    const cited = [
      ...conversation.results.answers.flatMap((answer) =>
        answer.sourceMessageIds.map((id) => ({ id, kind: "answer" })),
      ),
      ...conversation.results.notes.flatMap((note) =>
        note.sourceMessageIds.map((id) => ({ id, kind: "note" })),
      ),
    ];
    for (const cite of cited) {
      const owner = snapshot.messageOwner.get(cite.id);
      if (!owner) {
        continue;
      }
      if (owner !== conversation.conversationId) {
        findings.push({
          kind: "cross_conversation_citation",
          detail: `Conversation ${conversation.displayName} ${cite.kind} cites message ${cite.id} owned by conversation ${owner}`,
          conversationIds: [conversation.conversationId, owner],
        });
      }
    }
  }
  return findings;
}

function findLostParticipantText(snapshot, byPersonaId) {
  const findings = [];
  for (const conversation of snapshot.conversations) {
    const entry = byPersonaId.get(conversation.personaId);
    // Same rule as the input-quiescence check: after STOP the campaign keeps metadata
    // only, so text sent afterwards is discarded on purpose and is not a loss.
    // Reporting it as one sent us hunting a data-loss bug that was the product
    // honouring an opt-out.
    const lifecycle = conversation.detail.lifecycle;
    const stoppedAt =
      lifecycle.reason === "stopped" && lifecycle.closedAt
        ? Date.parse(lifecycle.closedAt)
        : undefined;
    // Same rule for a voice note or a photo: the product deliberately has
    // nowhere to put a body it never received, and the participant is told so
    // once. Counting it as lost text would report the media path as data loss.
    const missing = entry.injected.filter(
      (injected) =>
        injected.text !== null &&
        !(stoppedAt !== undefined && Date.parse(injected.at) >= stoppedAt) &&
        !conversation.detail.messages.some(
          (message) =>
            message.actor === "participant" &&
            message.text.trim() === injected.text.trim(),
        ),
    );
    if (missing.length > 0) {
      findings.push({
        kind: "lost_participant_text",
        detail: `${conversation.displayName}: ${missing.length} injected message(s) missing from the transcript (first: ${truncate(missing[0].text)})`,
        conversationIds: [conversation.conversationId],
      });
    }
  }
  return findings;
}

function findCampaignsNotTerminal(
  snapshot,
  byCampaignSlug,
  { when = "at the deadline" } = {},
) {
  const findings = [];
  for (const campaign of byCampaignSlug.values()) {
    const open = snapshot.conversations.filter(
      (row) =>
        row.campaignId === campaign.campaignId &&
        row.actual.lifecycle === "open" &&
        !row.ingestedAndQuiet,
    );
    if (open.length > 0) {
      findings.push({
        kind: "campaign_not_terminal",
        detail: `Campaign ${campaign.slug} still had ${open.length} open conversation(s) whose inputs were not ingested + quiet ${when}`,
        conversationIds: open.map((row) => row.conversationId),
      });
    }
  }
  return findings;
}

async function findFailedJobs(snapshot, fixtureSlot) {
  const redisUrl = String(process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    return [];
  }
  const backendRequire = createRequire(
    path.join(repositoryRoot, "apps/backend/package.json"),
  );
  const { Queue } = backendRequire("bullmq");
  // Queue names and prefix come from the backend so this cannot drift again. Naming the
  // queue without its prefix read `bull:feedback:*` — a key space the app never
  // writes — so every run before 2026-07-27 reported zero failed jobs because
  // it was looking somewhere empty, not because none had failed.
  const queueConstants =
    await import("../apps/backend/dist/infrastructure/queue/queue.constants.js");
  // The path spans legacy drain, ingress materialization and V2 conversation
  // reconciliation. Omitting any one can turn a failed run into `findings: []`.
  const queues = resolveFeedbackBurstQueueNames(queueConstants).map(
    (name) =>
      new Queue(name, {
        connection: redisConnectionFromUrl(redisUrl),
        prefix: queueConstants.QUEUE_PREFIX,
      }),
  );
  try {
    const failed = (
      await Promise.all(queues.map((queue) => queue.getFailed(0, 200)))
    ).flat();
    const conversationIds = new Set(
      snapshot.conversations.map((row) => row.conversationId),
    );
    const findings = [];
    for (const job of failed) {
      const conversationId = job.data?.conversationId;
      const reason = String(job.failedReason ?? "");
      if (
        !feedbackBurstFailedJobBelongsToSlot({
          fixtureSlot,
          conversationId,
          currentConversationIds: conversationIds,
          failedReason: reason,
        })
      ) {
        continue;
      }
      const ids =
        typeof conversationId === "string" &&
        conversationIds.has(conversationId)
          ? [conversationId]
          : [...conversationIds];
      if (
        /exhausted/iu.test(reason) ||
        /Scripted burst persona/iu.test(reason)
      ) {
        findings.push({
          kind: "script_exhausted",
          detail: reason || `Job ${job.name} exhausted its stub`,
          conversationIds: ids,
        });
      } else {
        findings.push({
          kind: "job_failed",
          detail: `${job.name}: ${reason || "failed"}`,
          conversationIds: ids,
        });
      }
    }
    return findings;
  } finally {
    await Promise.all(
      queues.map((queue) => queue.close().catch(() => undefined)),
    );
  }
}

function redisConnectionFromUrl(redisUrl) {
  const url = new URL(redisUrl);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 6379,
    db: url.pathname.slice(1) ? Number(url.pathname.slice(1)) : 0,
    ...(url.password ? { password: decodeURIComponent(url.password) } : {}),
    maxRetriesPerRequest: 1,
  };
}

function truncate(text, max = 80) {
  const value = String(text);
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--") {
      continue;
    }
    if (value === "--help" || value === "-h") {
      parsed.help = true;
      continue;
    }
    if (
      value === "--confirm-paid-run" ||
      value === "--confirm-transport-faults" ||
      value === "--seed-only" ||
      value === "--live-guests" ||
      value === "--confirm-live-guests"
    ) {
      parsed[value.slice(2)] = true;
      continue;
    }
    if (!value?.startsWith("--")) {
      throw new Error(`Unexpected argument: ${String(value)}`);
    }
    const name = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Argument --${name} requires a value`);
    }
    parsed[name] = next;
    index += 1;
  }
  return parsed;
}

function positiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function simulatedTransportTreatmentIsActive(transport) {
  return (
    transport.mode === "simulated" &&
    (transport.profile?.faultMode !== "none" ||
      Number(transport.profile?.maxDelayMs ?? 0) > 0)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve and validate an exact named treatment against the built worker.
 *
 * This checks both halves of the model contract before the API is allowed to
 * seed anything: the public model id still routes through the expected provider
 * adapter, and every profile control is accepted by the resolver code the
 * worker executes. The caller separately compares this result with the running
 * API's effective catalog.
 */
async function resolveTreatmentConfig(treatment) {
  const [modelService, assistantModels] = await Promise.all([
    import("../apps/backend/dist/modules/post-event-feedback/extraction/model.service.js"),
    import("../apps/backend/dist/modules/assistant/assistant-models.js"),
  ]);
  assertFeedbackBurstTreatmentAdapter(
    treatment,
    assistantModels.assistantModelAdapter(treatment.model),
  );
  const config = {
    reasoningEffort:
      modelService.resolveFeedbackExtractionReasoningEffort(
        treatment.controls.reasoningEffort,
      ) ?? null,
    replyReasoningEffort: modelService.resolveFeedbackReplyReasoningEffort(
      treatment.controls.replyReasoningEffort,
    ),
    attentionReasoningEffort:
      modelService.resolveFeedbackAttentionReasoningEffort(
        treatment.controls.attentionReasoningEffort,
      ),
    serviceTier:
      modelService.resolveFeedbackExtractionServiceTier(
        treatment.controls.serviceTier ?? undefined,
      ) ?? null,
  };
  if (!isDeepStrictEqual(config, treatment.controls)) {
    throw new Error(
      `Burst treatment ${treatment.name} controls drifted in the built worker (expected ${JSON.stringify(treatment.controls)}, resolved ${JSON.stringify(config)})`,
    );
  }
  return config;
}

/**
 * Sum token usage and USD cost across this run's Mongo conversations.
 *
 * The rules live in `summarizeThreadsCost` (model-prices.mjs), where they are
 * testable — this wrapper only owns the guarded HTTP round trip to the API's
 * own MongoDB. Soft-fails on accounting errors: a paid run must not die at the
 * final accounting step the way
 * `readGitRevision` soft-fails on a missing git.
 */
async function readRunTokenCost({ apiBase, headers, campaignIds }) {
  const ids = campaignIds.filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  if (ids.length === 0) {
    return { tokenUsage: null, costUsd: null };
  }

  try {
    const query = new URLSearchParams();
    for (const campaignId of ids) {
      query.append("campaignId", campaignId);
    }
    const rows = await requestJson(
      `${apiBase}/dev/feedback/burst/accounting?${query.toString()}`,
      { headers },
    );
    return summarizeThreadsCost(rows);
  } catch (error) {
    console.error(
      `cost accounting skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { tokenUsage: null, costUsd: null };
  }
}

/** Human line printed beside the report path. */
function formatCostLine(tokenUsage, runCostUsd) {
  if (
    tokenUsage == null ||
    typeof tokenUsage.inputTokens !== "number" ||
    typeof tokenUsage.outputTokens !== "number"
  ) {
    return "cost: unavailable (usage not recorded)";
  }
  const tokens = `${formatTokenCount(tokenUsage.inputTokens)} in / ${formatTokenCount(tokenUsage.outputTokens)} out`;
  if (typeof runCostUsd !== "number" || !Number.isFinite(runCostUsd)) {
    return `cost: unavailable (${tokens})`;
  }
  return `cost: $${runCostUsd.toFixed(2)} (${tokens})`;
}

/** Compact token counts for the cost line (`766k`, or the raw number under 1k). */
function formatTokenCount(tokens) {
  if (tokens >= 1_000) {
    return `${Math.round(tokens / 1_000)}k`;
  }
  return String(tokens);
}

function printUsage() {
  console.log(`Usage:
  pnpm feedback:burst

  pnpm feedback:burst \\
    --profile prova \\
    --fixture-slot 1 \\
    --confirm-paid-run

Options:
  --profile prova        Exact paid profile: direct OpenAI Luna, extraction,
                         attention and reply rewrite medium; service tier unset.
                         Omit for stub mode.
  --comparison qwen      Explicit Qwen/OpenRouter comparison using the same efforts.
  --confirm-paid-run     Required acknowledgement of extraction/classifier model cost
  --confirm-transport-faults
                         Required when simulated delivery injects faults or latency
  --seed-only            Launch intro-only campaigns, map all conversations, then stop.
                         Makes no participant or provider-model calls.
  --live-guests          Enable cursor-agent calls for the six unscripted personas.
                         Requires a paid profile/comparison; stub cannot read them.
                         Omit to substitute deterministic silence.
  --confirm-live-guests  Separate acknowledgement required with --live-guests
  --fixture-slot <0-9>   Non-destructive seed namespace; default 0 preserves the
                         historical phones, emails and event titles. Slots 1–9
                         require paid mode and are each permanently consumable.
  --correlation-id <id>  Optional stable log ID; generated when omitted
  --api-base <url>       Default: http://localhost:4000/api/v1
  --admin-base <url>     Default: http://localhost:3000
  --token <bearer>       Optional; defaults to CLERK_BEARER_TOKEN
  --token-file <path>    Optional rotating token; defaults to CLERK_BEARER_TOKEN_FILE
  --timeout-ms <ms>      Settlement deadline; default: 1800000 (30 minutes)

The API and worker must already be running with:
  NODE_ENV=development
  FEEDBACK_SIMULATOR_ENABLED=true
  TRANSPORT_MODE=simulated
  FEEDBACK_EXTRACTION_STUB=true          # default free mode
  # prova instead requires exactly:
  FEEDBACK_EXTRACTION_STUB=false
  FEEDBACK_EXTRACTION_MODEL=openai/gpt-5.6-luna
  FEEDBACK_EXTRACTION_REASONING_EFFORT=medium
  FEEDBACK_REPLY_REASONING_EFFORT=medium
  FEEDBACK_ATTENTION_REASONING_EFFORT=medium
  FEEDBACK_EXTRACTION_SERVICE_TIER=      # unset
  FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODE=none
  FEEDBACK_SIMULATED_TRANSPORT_FAULT_PERCENT=0
  FEEDBACK_SIMULATED_TRANSPORT_SEED=1
  FEEDBACK_SIMULATED_TRANSPORT_MAX_DELAY_MS=0

For a reply-path fault rehearsal, first run --seed-only under the baseline
none/0/0ms profile. Then stop every feedback worker, restart the API and all
workers with one identical fault profile, verify the catalog, and run with
--confirm-transport-faults. A fresh faulted launch may legitimately fail an
intro and will stop immediately instead of accepting an old sink row by phone.

Seed identity is +306900<slot><cc><pp>, a slot-specific participant email and a
slot-qualified event title. Persona ids and campaign slugs stay canonical. The
command never cleans up: inspect the persisted campaigns, conversations and
report afterward.`);
}
