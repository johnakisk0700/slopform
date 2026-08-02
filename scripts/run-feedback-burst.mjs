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
 * - Participants are keyed by the reserved phone block `+3069000<cc><pp>`.
 * - Events are keyed by the catalogue campaign title (exact match).
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
import { openBurstInspection } from "./burst-inspect.mjs";
import {
  assertFeedbackBurstLiveGuestCallAllowed,
  assertFeedbackBurstLiveGuestTreatment,
  assertFeedbackBurstQuestionSetVersion,
  assertFeedbackBurstTreatmentAdapter,
  resolveFeedbackBurstLiveGuests,
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
  events,
} = await import("../packages/database/dist/index.js");
const { BURST_CAMPAIGNS } =
  await import("../apps/backend/dist/modules/post-event-feedback/burst/burst-scenario.js");
const { BURST_PERSONAS } =
  await import("../apps/backend/dist/modules/post-event-feedback/burst/burst-personas.js");
const burstConversationCount = BURST_PERSONAS.length;
const burstCampaignCount = BURST_CAMPAIGNS.length;
const { asc, eq, inArray } = require("drizzle-orm");

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
// Settlement can still flip after the quiet window with no new messages — the
// settle rule itself waits `QUIET_WINDOW_MS + 5s` after the last inject. Count
// stalls only once every unsettled row is past that, then give up after a few
// unchanged polls. Without this a single stuck conversation burns the full
// fifteen-minute deadline; a shorter blind timer would cut off a slow but
// healthy extraction that is still producing replies.
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
  try {
    args = parseArgs(process.argv.slice(2));
    treatment = resolveFeedbackBurstTreatment(args);
    liveGuestsEnabled = resolveFeedbackBurstLiveGuests(args);
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
  const correlationId = String(
    args["correlation-id"] ?? `feedback-burst-${randomUUID()}`,
  );
  if (!REQUEST_ID_PATTERN.test(correlationId)) {
    throw new Error(
      "--correlation-id must be 1-128 log-safe letters, digits, dots, underscores, or hyphens",
    );
  }
  const headers = {
    "content-type": "application/json",
    "x-request-id": correlationId,
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };

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

  const catalog = await requestJson(`${apiBase}/dev/feedback/burst/catalog`, {
    headers,
  });
  const providerConversationCount = catalog.personas.filter(
    (persona) => liveGuestsEnabled || !persona.liveModel,
  ).length;
  const liveGuestRun = {
    mode: liveGuestsEnabled ? "cursor_agent" : "deterministic_silence",
    total: liveGuestsById.size,
    substituted: liveGuestsEnabled ? 0 : liveGuestsById.size,
  };

  if (treatment) {
    const simulatorCatalog = await requestJson(
      `${apiBase}/dev/feedback/simulator/catalog`,
      { headers },
    );
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

  if (treatment && !args["confirm-paid-run"]) {
    console.error("Paid real-model burst rehearsal not confirmed.");
    console.error(`  treatment:      ${treatment.name}`);
    console.error(`  model:          ${paidModel}`);
    console.error(
      `  provider-driven:${String(providerConversationCount).padStart(4, " ")}`,
    );
    console.error(
      `The ${providerConversationCount} personas with testimony can make extraction and attention-classification provider calls. The run permanently consumes the seeded campaigns and leaves all normal persisted outputs in place.`,
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
    stubMode
      ? "Starting deterministic burst rehearsal (FEEDBACK_EXTRACTION_STUB):"
      : "Starting confirmed paid burst rehearsal:",
  );
  console.error(`  model:          ${modelLabel}`);
  if (treatment) {
    console.error(`  treatment:      ${treatment.name}`);
  }
  console.error(`  conversations:  ${burstConversationCount}`);
  console.error(`  correlation ID: ${correlationId}`);
  console.error(`  deadline:       ${deadlineMs}ms`);
  if (runConfig) {
    console.error(`  controls:       ${JSON.stringify(runConfig)}`);
  }

  console.log(
    JSON.stringify({
      event: "feedback_burst.started",
      model: modelLabel,
      treatment: treatment?.name ?? null,
      config: runConfig,
      liveGuests: liveGuestRun,
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

    console.error("Waiting for intro delivery into the simulated sink…");
    await waitForIntros({
      db: client.db,
      catalog,
      timeoutMs: INTRO_WAIT_MS,
    });

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
      `All injects finished in ${Math.round((Date.now() - driveStarted) / 1000)}s; polling for settlement…`,
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
      });
      const unsettled = snapshot.conversations.filter((row) => !row.settled);
      const line = `settled ${snapshot.conversations.length - unsettled.length}/${snapshot.conversations.length}${
        unsettled.length > 0
          ? ` (waiting: ${unsettled
              .slice(0, 5)
              .map((row) => row.personaId)
              .join(", ")}${unsettled.length > 5 ? "…" : ""})`
          : ""
      }`;
      console.error(line);
      if (unsettled.length === 0) {
        break;
      }
      if (Date.now() >= deadlineAt) {
        timedOut = true;
        console.error("Deadline reached with unsettled conversations.");
        break;
      }
      // Fingerprint settled membership and every conversation's message count.
      // Lifecycle-only thrash without a new message or a newly settled row is
      // exactly the stuck case this exit is for.
      const progressKey = snapshot.conversations
        .map(
          (row) =>
            `${row.personaId}:${row.settled ? "1" : "0"}:${row.messageCount}`,
        )
        .sort()
        .join("|");
      const waitingOnQuiet = unsettled.some((row) => !row.quietElapsed);
      if (!waitingOnQuiet && progressKey === previousProgressKey) {
        unchangedPolls += 1;
        if (unchangedPolls >= STALL_POLLS) {
          gaveUpEarly = true;
          console.error(
            `Gave up early: no settlement progress for ${STALL_POLLS} polls (~${(STALL_POLLS * POLL_MS) / 1_000}s) with nothing in flight.`,
          );
          console.error(
            `Unsettled personas: ${unsettled.map((row) => row.personaId).join(", ")}`,
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
    });

    const findings = [
      ...findDuplicateOutbound(finalSnapshot),
      ...findCrossConversationCitations(finalSnapshot),
      ...findLostParticipantText(finalSnapshot, byPersonaId),
      ...(timedOut || gaveUpEarly
        ? findCampaignsNotTerminal(finalSnapshot, byCampaignSlug, {
            when: gaveUpEarly
              ? "when settlement gave up early"
              : "at the deadline",
          })
        : []),
      ...(await findFailedJobs(finalSnapshot)),
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
    // Token/cost come from Mongo conversation documents. Usage fields may be
    // absent on older data — report null ("unavailable"), never invent 0.
    const { tokenUsage, costUsd: runCostUsd } =
      await readRunTokenCost(campaignIds);
    const result = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      model: modelLabel,
      treatment: treatment?.name ?? null,
      config: runConfig,
      liveGuests: liveGuestRun,
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
 * surface. Participants use the reserved phone block; events use catalogue
 * titles. See file header for the idempotency rules.
 */
async function seedWorld({ db, catalog, apiBase, headers }) {
  const personaRows = [];
  for (const persona of catalog.personas) {
    const participantId = await upsertBurstParticipant(db, persona);
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

async function upsertBurstParticipant(db, persona) {
  const email = `burst.${persona.campaign}.${String(persona.ordinal).padStart(2, "0")}@burst.jointhesix.local`;
  const existing = await db
    .select()
    .from(participants)
    .where(eq(participants.phoneE164, persona.phoneE164))
    .limit(1);
  if (existing[0]) {
    const row = existing[0];
    // The email is the seat; the name is whichever persona currently sits in
    // it. Retiring a persona and seating a new one on the same phone is an
    // ordinary catalogue change — it happened the first time a row was replaced
    // — and refusing it left an orphan that blocked every later run with a
    // message about a participant nobody could find. A *different* email on a
    // reserved phone is the case this guard is really for, and still refuses.
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

async function waitForIntros({ db, catalog, timeoutMs }) {
  const phones = catalog.personas.map((persona) => persona.phoneE164);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const rows = await db
      .select()
      .from(feedbackSimOutbound)
      .where(inArray(feedbackSimOutbound.phoneE164, phones));
    const byPhone = new Map();
    for (const row of rows) {
      const list = byPhone.get(row.phoneE164) ?? [];
      list.push(row);
      byPhone.set(row.phoneE164, list);
    }
    const missing = phones.filter(
      (phone) => (byPhone.get(phone) ?? []).length === 0,
    );
    if (missing.length === 0) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Timed out waiting for intro delivery. Missing phones: ${missing.join(", ")}`,
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
 * fails settlement for its whole campaign.
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

    await requestJson(`${apiBase}/dev/feedback/simulator/inject`, {
      method: "POST",
      headers: {
        ...headers,
        "x-request-id": `${correlationId}-${persona.id}-${randomUUID().slice(0, 8)}`,
      },
      body: JSON.stringify({
        phoneE164: persona.phoneE164,
        text,
        fromMe: false,
      }),
    });
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
  for (const message of persona.messages) {
    if (message.afterMs > 0) {
      await sleep(message.afterMs);
    }
    // `text: null` is a voice note, photo or reaction. It travels through the
    // same inject route — the point of the persona who sends them is that the
    // ordinary path is what decides they cannot become testimony.
    await requestJson(`${apiBase}/dev/feedback/simulator/inject`, {
      method: "POST",
      headers: {
        ...headers,
        "x-request-id": `${correlationId}-${persona.id}-${randomUUID().slice(0, 8)}`,
      },
      body: JSON.stringify({
        phoneE164: persona.phoneE164,
        text: message.text ?? null,
        fromMe: false,
      }),
    });
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
        // Each extraction run makes two model calls (propose + classify). Count
        // distinct extraction timestamps on answers/notes as a lower bound.
        modelCalls: countModelCalls(answerRows, noteRows),
      };

      const expectations = buildExpectations(persona, actual, received);
      // Text sent after a STOP is deliberately not retained — the campaign
      // keeps metadata only once somebody has opted out, because not storing is
      // reversible and storing is not. Requiring it in the transcript therefore
      // asks for something the product must never do: the run reported
      // `lost_participant_text` for a message we correctly discarded, failed on
      // it, and burned its whole settlement deadline waiting for it to appear.
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
        // waiting for one to appear would never settle.
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
      // hostile fork instead of S69 — could never settle, burned the stall
      // detector, and surfaced as `campaign_not_terminal`, the exact finding
      // shape of a dead system. Ten of the first fourteen ledgered runs
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
      const settled = injectCaughtUp && quietElapsed;

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
        settled,
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
  // propose + classify per extraction run
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
function buildExpectations(persona, actual, received) {
  const { expect } = persona;
  const deliveredRow = {
    label: "μηνύματα που έφτασαν",
    expected: `${expect.minReceived}–${expect.maxReceived}`,
    actual: String(received.length),
    passed:
      received.length >= expect.minReceived &&
      received.length <= expect.maxReceived,
  };
  if (persona.liveModel) {
    return [deliveredRow];
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
  const expectations = row.expectations.map((expectation) => ({
    ...expectation,
    // Paid mode: semantic expectations are observations, not failures.
    passed: stubMode ? expectation.passed : true,
  }));
  const semanticFailed =
    stubMode && row.expectations.some((expectation) => !expectation.passed);
  return {
    personaId: row.personaId,
    displayName: row.displayName,
    quirk: row.quirk,
    mirrors: row.mirrors,
    phoneE164: row.phoneE164,
    conversationId: row.conversationId,
    adminUrl: `${adminBase}/admin/feedback/${encodeURIComponent(campaignId)}?conversation=${encodeURIComponent(row.conversationId)}`,
    passed: !semanticFailed,
    expectations: stubMode
      ? row.expectations
      : row.expectations.map((expectation) => ({
          ...expectation,
          label: `observation: ${expectation.label}`,
        })),
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
    // Same rule as the settle check: after STOP the campaign keeps metadata
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
        !row.settled,
    );
    if (open.length > 0) {
      findings.push({
        kind: "campaign_not_terminal",
        detail: `Campaign ${campaign.slug} still had ${open.length} unsettled open conversation(s) ${when}`,
        conversationIds: open.map((row) => row.conversationId),
      });
    }
  }
  return findings;
}

async function findFailedJobs(snapshot) {
  const redisUrl = String(process.env.REDIS_URL ?? "").trim();
  if (!redisUrl) {
    return [];
  }
  const backendRequire = createRequire(
    path.join(repositoryRoot, "apps/backend/package.json"),
  );
  const { Queue } = backendRequire("bullmq");
  // Both values come from the backend so this cannot drift again. Naming the
  // queue without its prefix read `bull:feedback:*` — a key space the app never
  // writes — so every run before 2026-07-27 reported zero failed jobs because
  // it was looking somewhere empty, not because none had failed.
  const { FEEDBACK_INGRESS_QUEUE, FEEDBACK_QUEUE, QUEUE_PREFIX } =
    await import("../apps/backend/dist/infrastructure/queue/queue.constants.js");
  // Both queues, because the loop spans both: a message that never reached the
  // transcript fails on `feedback-ingress`, and reading only `feedback` would
  // report the run as clean while its inbound messages were being buried.
  const queues = [FEEDBACK_QUEUE, FEEDBACK_INGRESS_QUEUE].map(
    (name) =>
      new Queue(name, {
        connection: redisConnectionFromUrl(redisUrl),
        prefix: QUEUE_PREFIX,
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
      const relevant =
        typeof conversationId === "string" &&
        conversationIds.has(conversationId);
      const reason = String(job.failedReason ?? "");
      if (!relevant && !reason.includes("exhausted")) {
        // Keep burst-scoped noise down: only report failures tied to this run's
        // conversations, or script-exhaustion which names a persona.
        if (!reason.includes("Scripted burst persona")) {
          continue;
        }
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

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      payload && typeof payload.message === "string"
        ? payload.message
        : Array.isArray(payload?.message)
          ? payload.message.join("; ")
          : `${response.status} ${response.statusText}`;
    throw new Error(`${url}: ${message}`);
  }
  return payload;
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
 * testable — this wrapper only owns the Mongo round trip. Soft-fails on Mongo
 * errors: a paid run must not die at the final accounting step the way
 * `readGitRevision` soft-fails on a missing git.
 */
async function readRunTokenCost(campaignIds) {
  const ids = campaignIds.filter(
    (id) => typeof id === "string" && id.length > 0,
  );
  if (ids.length === 0) {
    return { tokenUsage: null, costUsd: null };
  }

  let inspection;
  try {
    inspection = await openBurstInspection({
      applicationName: "feedback-burst-cost",
    });
  } catch (error) {
    console.error(
      `cost accounting skipped: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { tokenUsage: null, costUsd: null };
  }

  try {
    const threads = await inspection.findThreads({
      campaignId: { $in: ids },
    });
    return summarizeThreadsCost(threads);
  } finally {
    await inspection.close();
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
    --confirm-paid-run

Options:
  --profile prova        Exact paid profile: direct OpenAI Luna, extraction xhigh,
                         attention high, service tier unset. Omit for stub mode.
  --comparison qwen      Explicit Qwen/OpenRouter comparison using the same efforts.
  --confirm-paid-run     Required acknowledgement of extraction/classifier model cost
  --live-guests          Enable cursor-agent calls for the six unscripted personas.
                         Requires a paid profile/comparison; stub cannot read them.
                         Omit to substitute deterministic silence.
  --confirm-live-guests  Separate acknowledgement required with --live-guests
  --correlation-id <id>  Optional stable log ID; generated when omitted
  --api-base <url>       Default: http://localhost:4000/api/v1
  --admin-base <url>     Default: http://localhost:3000
  --token <bearer>       Optional; defaults to CLERK_BEARER_TOKEN
  --timeout-ms <ms>      Settlement deadline; default: 1800000 (30 minutes)

The API and worker must already be running with:
  NODE_ENV=development
  FEEDBACK_SIMULATOR_ENABLED=true
  TRANSPORT_MODE=simulated
  FEEDBACK_EXTRACTION_STUB=true          # default free mode
  # prova instead requires exactly:
  FEEDBACK_EXTRACTION_STUB=false
  FEEDBACK_EXTRACTION_MODEL=openai/gpt-5.6-luna
  FEEDBACK_EXTRACTION_REASONING_EFFORT=xhigh
  FEEDBACK_ATTENTION_REASONING_EFFORT=high
  FEEDBACK_EXTRACTION_SERVICE_TIER=      # unset

Seed identity is the reserved phone block +3069000<cc><pp> and the catalogue
event titles. The command never cleans up: inspect the persisted campaigns,
conversations and report afterward.`);
}
