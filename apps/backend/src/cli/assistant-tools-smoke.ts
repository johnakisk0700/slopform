/**
 * Checks the `supportsTools` claim in `assistant-models.ts` against the four
 * providers, with real paid calls.
 *
 * The adapter table asserts that every assistant model can call a tool. That is
 * a claim about someone else's service, so nothing in the test suite can settle
 * it — a mocked provider only ever confirms our own wiring. This script asks
 * each model, one cheap question apiece, and reports which ones actually issued
 * the call.
 *
 * It spends money. Run it deliberately, after changing the model table or the
 * tool schemas, not on every commit:
 *
 *   pnpm --filter @slopform/backend exec node dist/cli/assistant-tools-smoke.js
 *
 * A model that answers in prose instead of calling the tool has failed the
 * check: flip its `supportsTools` to false rather than hoping the next prompt
 * persuades it.
 */
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

const MODELS = [
  {
    id: "openai/gpt-5.6-luna",
    provider: "openai",
    providerModelId: "gpt-5.6-luna",
  },
  {
    id: "openai/gpt-5.6-terra",
    provider: "openai",
    providerModelId: "gpt-5.6-terra",
  },
  {
    id: "google/gemini-3.6-flash",
    provider: "openrouter",
    providerModelId: "google/gemini-3.6-flash",
  },
  {
    id: "qwen/qwen3.7-max",
    provider: "openrouter",
    providerModelId: "qwen/qwen3.7-max",
  },
] as const;

type SmokeEntry = (typeof MODELS)[number];
type SmokeRow = Record<string, unknown>;

/**
 * A stand-in shaped like the real registry, not a toy.
 *
 * The point of the run is the schema subset as much as the capability: a flat
 * object with an optional described enum is the most demanding shape the real
 * tools use, so a provider that accepts this accepts all of them.
 */
function probeTool(calls: { status: string | null }[]) {
  return tool({
    description:
      "List events with their date, status and attendance. Call this to answer anything about scheduled events.",
    inputSchema: z.object({
      status: z
        .enum(["draft", "scheduled", "finished", "cancelled"])
        .optional()
        .describe("Keep only events in this status."),
    }),
    execute: async ({ status }) => {
      calls.push({ status: status ?? null });
      return {
        rows: [
          {
            title: "Sunday Six",
            startsAt: "2026-08-09T18:00:00.000Z",
            status: "scheduled",
          },
        ],
        total: 1,
      };
    },
  });
}

function resolveModel({ provider, providerModelId }: SmokeEntry) {
  if (provider === "openrouter") {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("OPENROUTER_API_KEY is not set");
    return createOpenRouter({ apiKey: key })(providerModelId);
  }
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  return createOpenAI({ apiKey: key })(providerModelId);
}

async function probe(entry: SmokeEntry): Promise<SmokeRow> {
  const calls: { status: string | null }[] = [];
  const started = Date.now();

  const result = await generateText({
    model: resolveModel(entry),
    system:
      "You are an operations assistant. Use the tools available to you rather than guessing.",
    prompt: "Which events are currently scheduled?",
    tools: { list_events: probeTool(calls) },
    stopWhen: stepCountIs(4),
    maxOutputTokens: 512,
    maxRetries: 0,
    timeout: { totalMs: 90_000 },
    providerOptions:
      entry.provider === "openrouter"
        ? {
            openrouter: {
              reasoning: { effort: "low" },
              provider: { require_parameters: true },
            },
          }
        : { openai: { reasoningEffort: "low" } },
  });

  return {
    model: entry.id,
    calledTool: calls.length > 0,
    callCount: calls.length,
    steps: result.steps?.length ?? 1,
    ms: Date.now() - started,
    answered: result.text.trim().length > 0,
  };
}

const rows: SmokeRow[] = [];
for (const entry of MODELS) {
  try {
    rows.push(await probe(entry));
  } catch (error) {
    rows.push({
      model: entry.id,
      calledTool: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

console.table(rows);

const failed = rows.filter((row) => !row.calledTool);
if (failed.length > 0) {
  console.error(
    `\n${failed.length} of ${rows.length} models did not call the tool. Set supportsTools: false for: ${failed
      .map((row) => row.model)
      .join(", ")}`,
  );
  process.exitCode = 1;
}
