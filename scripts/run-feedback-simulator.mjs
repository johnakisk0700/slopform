#!/usr/bin/env node

import { randomUUID } from "node:crypto";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
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
    args["correlation-id"] ?? `feedback-eval-${randomUUID()}`,
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

  const catalog = await requestJson(
    `${apiBase}/dev/feedback/simulator/catalog`,
    { headers },
  );
  if (args.list) {
    console.log(
      JSON.stringify(
        {
          activeModel: catalog.activeModel,
          activeExtractionReasoningEffort:
            catalog.activeExtractionReasoningEffort,
          activeReplyReasoningEffort: catalog.activeReplyReasoningEffort,
          activeAttentionReasoningEffort:
            catalog.activeAttentionReasoningEffort,
          activeServiceTier: catalog.activeServiceTier,
          activeTransportMode: catalog.activeTransportMode,
          activeSimulatedTransport: catalog.activeSimulatedTransport,
          workerAttestation: catalog.workerAttestation,
          evalModels: catalog.availableModels,
          timingPolicy: catalog.timingPolicy,
          quietWindowMs: catalog.quietWindowMs,
          scenarios: catalog.scenarios,
        },
        undefined,
        2,
      ),
    );
    return;
  }

  const required = ["campaign", "conversation", "scenario", "model"];
  const missing = required.filter((name) => !args[name]);
  if (missing.length > 0) {
    console.error(`Missing required arguments: ${missing.join(", ")}`);
    printUsage();
    process.exitCode = 2;
    return;
  }

  const selectedScenario = catalog.scenarios.find(
    (scenario) => scenario.id === args.scenario,
  );
  if (!selectedScenario) {
    console.error(
      `Scenario "${args.scenario}" is not eligible from a clean intro baseline. Available scenarios:`,
    );
    for (const scenario of catalog.scenarios) {
      console.error(`  ${scenario.id} — ${scenario.title}`);
    }
    process.exitCode = 2;
    return;
  }
  if (!catalog.availableModels.includes(args.model)) {
    console.error(
      `Model "${args.model}" is outside this eval. Allowed models: ${catalog.availableModels.join(", ")}`,
    );
    process.exitCode = 2;
    return;
  }
  if (catalog.activeModel !== args.model) {
    console.error(
      `Configured model is ${catalog.activeModel}; requested ${args.model}.`,
    );
    console.error(
      `Restart the API and worker with: FEEDBACK_EXTRACTION_MODEL=${args.model} pnpm dev`,
    );
    process.exitCode = 2;
    return;
  }
  const effectiveConfig = {
    extractionReasoningEffort: catalog.activeExtractionReasoningEffort,
    replyReasoningEffort: catalog.activeReplyReasoningEffort,
    attentionReasoningEffort: catalog.activeAttentionReasoningEffort,
    serviceTier: catalog.activeServiceTier,
    transportMode: catalog.activeTransportMode,
    simulatedTransport: catalog.activeSimulatedTransport,
  };

  const selection = {
    campaignId: args.campaign,
    conversationId: args.conversation,
    scenarioId: args.scenario,
    expectedModel: args.model,
  };
  const links = {
    inbox: `${adminBase}/admin/feedback/${encodeURIComponent(args.campaign)}?conversation=${encodeURIComponent(args.conversation)}`,
    results: `${adminBase}/admin/feedback/${encodeURIComponent(args.campaign)}/results`,
  };
  const preview = await requestJson(
    `${apiBase}/dev/feedback/simulator/preflight`,
    {
      method: "POST",
      headers,
      body: JSON.stringify(selection),
    },
  );
  console.log(
    JSON.stringify({
      event: "feedback_eval.preflight",
      ...preview,
      config: effectiveConfig,
      links,
    }),
  );
  if (!effectiveConfig.extractionReasoningEffort) {
    console.error(
      "Paid mode requires an explicit FEEDBACK_EXTRACTION_REASONING_EFFORT; provider-default reasoning is not a reproducible treatment.",
    );
    console.error(
      `Restart both API and worker with FEEDBACK_EXTRACTION_MODEL=${args.model} and an explicit reasoning effort.`,
    );
    process.exitCode = 2;
    return;
  }
  if (!preview.workerRegistered) {
    console.error(
      preview.workerAttestation?.issue ??
        "The feedback worker does not have a verified control attestation. Start the current worker build with the same treatment before a paid run.",
    );
    process.exitCode = 2;
    return;
  }
  if (args.preflight) {
    return;
  }

  if (!args["confirm-paid-run"]) {
    console.error("Paid real-model run not confirmed.");
    console.error(`  model:        ${args.model}`);
    console.error(
      `  reasoning:    ${effectiveConfig.extractionReasoningEffort}`,
    );
    console.error(`  reply writer: ${effectiveConfig.replyReasoningEffort}`);
    console.error(
      `  classifier:   ${effectiveConfig.attentionReasoningEffort}`,
    );
    console.error(`  service tier: ${effectiveConfig.serviceTier ?? "unset"}`);
    console.error(
      `  transport:    ${formatSimulatedTransport(effectiveConfig)}`,
    );
    console.error(`  scenario:     ${args.scenario}`);
    console.error(`  campaign:     ${args.campaign}`);
    console.error(`  conversation: ${args.conversation}`);
    console.error(
      "This can make multiple paid provider calls, permanently consumes the clean conversation, and leaves all normal persisted outputs in place.",
    );
    console.error("Re-run with --confirm-paid-run to proceed.");
    process.exitCode = 2;
    return;
  }

  if (
    simulatedTransportTreatmentIsActive(effectiveConfig) &&
    !args["confirm-transport-faults"]
  ) {
    console.error("Simulated transport fault treatment not confirmed.");
    console.error(`  transport: ${formatSimulatedTransport(effectiveConfig)}`);
    console.error(
      "Re-run with --confirm-transport-faults, or restart API and worker with the baseline none/0/0ms profile.",
    );
    process.exitCode = 2;
    return;
  }

  const timeoutMs = positiveInteger(
    args["timeout-ms"] ?? "240000",
    "timeout-ms",
  );
  console.error(
    "Starting confirmed paid real-model evaluation (extraction, attention, and conditional reply rewrite):",
  );
  console.error(`  model:          ${args.model}`);
  console.error(
    `  reasoning:      ${effectiveConfig.extractionReasoningEffort}`,
  );
  console.error(`  reply writer:   ${effectiveConfig.replyReasoningEffort}`);
  console.error(
    `  classifier:     ${effectiveConfig.attentionReasoningEffort}`,
  );
  console.error(`  service tier:   ${effectiveConfig.serviceTier ?? "unset"}`);
  console.error(
    `  transport:      ${formatSimulatedTransport(effectiveConfig)}`,
  );
  console.error(`  scenario:       ${args.scenario}`);
  console.error(`  campaign:       ${args.campaign}`);
  console.error(`  conversation:   ${args.conversation}`);
  console.error(`  correlation ID: ${correlationId}`);

  let run = await requestJson(`${apiBase}/dev/feedback/simulator/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ...selection,
      confirmPaidRun: true,
    }),
  });

  console.log(
    JSON.stringify({
      event: "feedback_eval.started",
      runId: run.id,
      scenarioId: run.scenarioId,
      model: run.model.expected,
      campaignId: run.campaignId,
      conversationId: run.conversationId,
      correlationId: run.correlationId,
      config: effectiveConfig,
      feedbackVenue: preview.feedbackVenue,
      renderedMessages: run.renderedMessages,
      candidateBindings: run.candidateBindings,
      rubric: run.rubric,
      links,
    }),
  );

  const deadline = Date.now() + timeoutMs;
  let lastLine = "";
  while (true) {
    const line = `${run.stage}: ${run.progress.percent}% (${run.progress.materializedMessages}/${run.progress.totalMessages} materialized, cursor ${run.progress.currentCursorSeq}/${run.progress.targetCursorSeq})`;
    if (line !== lastLine) {
      console.error(line);
      lastLine = line;
    }

    if (run.stage === "processed" || run.stage === "failed") {
      console.log(
        JSON.stringify(
          {
            ...run,
            config: effectiveConfig,
            feedbackVenue: preview.feedbackVenue,
          },
          undefined,
          2,
        ),
      );
      process.exitCode = run.stage === "processed" ? 0 : 1;
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for simulator run ${run.id}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 2_000));
    run = await requestJson(
      `${apiBase}/dev/feedback/simulator/runs/${run.id}`,
      { headers },
    );
  }
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
    if (value === "--list") {
      parsed.list = true;
      continue;
    }
    if (value === "--preflight") {
      parsed.preflight = true;
      continue;
    }
    if (
      value === "--confirm-paid-run" ||
      value === "--confirm-transport-faults"
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

function formatSimulatedTransport(config) {
  const profile = config.simulatedTransport;
  if (!profile || config.transportMode !== "simulated") {
    return String(config.transportMode ?? "unknown");
  }
  return `simulated; fault=${profile.faultMode}@${profile.faultPercent}%; seed=${profile.seed}; max-delay=${profile.maxDelayMs}ms`;
}

function simulatedTransportTreatmentIsActive(config) {
  return (
    config.transportMode === "simulated" &&
    (config.simulatedTransport?.faultMode !== "none" ||
      Number(config.simulatedTransport?.maxDelayMs ?? 0) > 0)
  );
}

async function requestJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      payload && typeof payload.message === "string"
        ? payload.message
        : `${response.status} ${response.statusText}`;
    throw new Error(`${url}: ${message}`);
  }
  return payload;
}

function printUsage() {
  console.log(`Usage:
  pnpm feedback:simulate --list

  pnpm feedback:simulate \\
    --campaign <campaign-uuid> \\
    --conversation <conversation-uuid> \\
    --scenario <eligible-corpus-id> \\
    --model <openai/gpt-5.6-luna|qwen/qwen3.7-max> \\
    --preflight

  pnpm feedback:simulate \\
    --campaign <campaign-uuid> \\
    --conversation <conversation-uuid> \\
    --scenario <eligible-corpus-id> \\
    --model <openai/gpt-5.6-luna|qwen/qwen3.7-max> \\
    --confirm-paid-run

Options:
  --list                 List the active model and eligible scenarios; no writes
  --preflight            Resolve the exact clean baseline and rendered inputs; no writes
  --confirm-paid-run     Required acknowledgement of model cost and permanent data
  --confirm-transport-faults
                         Required when the active simulated transport injects
                         faults or latency; separate from model-cost confirmation
  --correlation-id <id>  Optional stable log ID; generated when omitted
  --api-base <url>       Default: http://localhost:4000/api/v1
  --admin-base <url>     Default: http://localhost:3000
  --token <bearer>       Optional; defaults to CLERK_BEARER_TOKEN
  --timeout-ms <ms>      Default: 240000

The API and worker must already be running with:
  NODE_ENV=development
  FEEDBACK_SIMULATOR_ENABLED=true
  TRANSPORT_MODE=simulated
  FEEDBACK_EXTRACTION_STUB=false
  FEEDBACK_EXTRACTION_MODEL=openai/gpt-5.6-luna
  FEEDBACK_EXTRACTION_REASONING_EFFORT=medium
  FEEDBACK_REPLY_REASONING_EFFORT=medium
  FEEDBACK_ATTENTION_REASONING_EFFORT=medium
  FEEDBACK_EXTRACTION_SERVICE_TIER=
  FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODE=none
  FEEDBACK_SIMULATED_TRANSPORT_FAULT_PERCENT=0
  FEEDBACK_SIMULATED_TRANSPORT_SEED=1
  FEEDBACK_SIMULATED_TRANSPORT_MAX_DELAY_MS=0

The command uses the normal ingress/materializer/queue/extractor/outbox path.
It never cleans up: inspect the persisted conversation and results afterward.`);
}
