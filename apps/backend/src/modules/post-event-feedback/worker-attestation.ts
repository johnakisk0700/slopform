import { z } from "zod";

import {
  feedbackSimulatedTransportProfileSchema,
  resolveFeedbackSimulatedTransportProfile,
} from "../../infrastructure/config/feedback-simulated-transport.js";

import { assistantModelAdapter } from "../assistant/assistant-models.js";
import { assistantModelSchema } from "../assistant/assistant.schemas.js";
import {
  FEEDBACK_EXTRACTION_REASONING_EFFORTS,
  FEEDBACK_EXTRACTION_SERVICE_TIERS,
  resolveFeedbackAttentionReasoningEffort,
  resolveFeedbackExtractionModel,
  resolveFeedbackExtractionReasoningEffort,
  resolveFeedbackExtractionServiceTier,
  resolveFeedbackReplyReasoningEffort,
} from "./extraction/model.service.js";

export const FEEDBACK_WORKER_ATTESTATION_VERSION = 3 as const;
export const FEEDBACK_WORKER_ATTESTATION_STATUSES = [
  "verified",
  "absent",
  "malformed",
  "mismatch",
] as const;

const FEEDBACK_WORKER_REGISTRATION_PREFIX =
  "jts-feedback-worker-attestation-v3.";
const BULLMQ_NAMED_WORKER_SEPARATOR = ":w:";

export const feedbackWorkerControlProfileSchema = z
  .object({
    version: z.literal(FEEDBACK_WORKER_ATTESTATION_VERSION),
    extractionStub: z.boolean(),
    model: assistantModelSchema,
    provider: z.enum(["openai", "openrouter"]),
    providerModelId: z.string().trim().min(1).max(200),
    extractionReasoningEffort: z
      .enum(FEEDBACK_EXTRACTION_REASONING_EFFORTS)
      .nullable(),
    replyReasoningEffort: z.enum(FEEDBACK_EXTRACTION_REASONING_EFFORTS),
    attentionReasoningEffort: z.enum(FEEDBACK_EXTRACTION_REASONING_EFFORTS),
    serviceTier: z.enum(FEEDBACK_EXTRACTION_SERVICE_TIERS).nullable(),
    transportMode: z.enum(["disabled", "simulated", "wasender"]),
    simulatedTransport: feedbackSimulatedTransportProfileSchema,
  })
  .strict();

export type FeedbackWorkerControlProfile = z.infer<
  typeof feedbackWorkerControlProfileSchema
>;

export const feedbackWorkerAttestationSchema = z
  .object({
    status: z.enum(FEEDBACK_WORKER_ATTESTATION_STATUSES),
    registeredWorkerCount: z.number().int().nonnegative(),
    malformedWorkerCount: z.number().int().nonnegative(),
    observedProfiles: z.array(feedbackWorkerControlProfileSchema),
    issue: z.string().trim().min(1).max(500).nullable(),
  })
  .strict();

export type FeedbackWorkerAttestation = z.infer<
  typeof feedbackWorkerAttestationSchema
>;

interface FeedbackWorkerControlInput {
  readonly extractionStub: boolean;
  readonly model: string | undefined;
  readonly extractionReasoningEffort: string | undefined;
  readonly replyReasoningEffort: string | undefined;
  readonly attentionReasoningEffort: string | undefined;
  readonly serviceTier: string | undefined;
  readonly transportMode?: string | undefined;
  readonly simulatedTransportFaultMode?: unknown;
  readonly simulatedTransportFaultPercent?: unknown;
  readonly simulatedTransportSeed?: unknown;
  readonly simulatedTransportMaxDelayMs?: unknown;
}

interface BullMqWorkerInfo {
  readonly rawname?: string;
  readonly [key: string]: string | undefined;
}

/**
 * Resolve the complete control plane that changes what feedback extraction
 * actually asks a provider to do. The service tier is effective rather than
 * merely configured: OpenRouter has no OpenAI service-tier request option.
 */
export function resolveFeedbackWorkerControlProfile(
  input: FeedbackWorkerControlInput,
): FeedbackWorkerControlProfile {
  const model = resolveFeedbackExtractionModel(input.model);
  const adapter = assistantModelAdapter(model);
  const configuredServiceTier = resolveFeedbackExtractionServiceTier(
    input.serviceTier,
  );

  return feedbackWorkerControlProfileSchema.parse({
    version: FEEDBACK_WORKER_ATTESTATION_VERSION,
    extractionStub: input.extractionStub,
    model,
    provider: adapter.provider,
    providerModelId: adapter.providerModelId,
    extractionReasoningEffort:
      resolveFeedbackExtractionReasoningEffort(
        input.extractionReasoningEffort,
      ) ?? null,
    replyReasoningEffort: resolveFeedbackReplyReasoningEffort(
      input.replyReasoningEffort,
    ),
    attentionReasoningEffort: resolveFeedbackAttentionReasoningEffort(
      input.attentionReasoningEffort,
    ),
    serviceTier:
      adapter.provider === "openai" ? (configuredServiceTier ?? null) : null,
    transportMode: z
      .enum(["disabled", "simulated", "wasender"])
      .default("simulated")
      .parse(emptyToUndefined(input.transportMode)),
    simulatedTransport: resolveFeedbackSimulatedTransportProfile({
      faultMode: input.simulatedTransportFaultMode,
      faultPercent: input.simulatedTransportFaultPercent,
      seed: input.simulatedTransportSeed,
      maxDelayMs: input.simulatedTransportMaxDelayMs,
    }),
  });
}

/**
 * BullMQ exposes a Worker's `opts.name` through Redis CLIENT LIST. Encoding the
 * full, non-secret profile there lets the HTTP process prove which worker is
 * alive instead of proving only that some process has a blocking connection.
 */
export function createFeedbackWorkerRegistrationName(
  profile: FeedbackWorkerControlProfile,
): string {
  const parsed = assertAdapterMatchesModel(profile);
  const payload = Buffer.from(JSON.stringify(parsed), "utf8").toString(
    "base64url",
  );
  return `${FEEDBACK_WORKER_REGISTRATION_PREFIX}${payload}`;
}

export function parseFeedbackWorkerRegistrationName(
  registrationName: string,
): FeedbackWorkerControlProfile {
  if (!registrationName.startsWith(FEEDBACK_WORKER_REGISTRATION_PREFIX)) {
    throw new Error("Feedback worker registration has no v3 attestation");
  }

  const encoded = registrationName.slice(
    FEEDBACK_WORKER_REGISTRATION_PREFIX.length,
  );
  if (!encoded || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error("Feedback worker attestation payload is malformed");
  }

  let decoded: string;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      throw new Error("non-canonical base64url");
    }
    decoded = bytes.toString("utf8");
  } catch {
    throw new Error("Feedback worker attestation payload is malformed");
  }

  try {
    return assertAdapterMatchesModel(
      feedbackWorkerControlProfileSchema.parse(JSON.parse(decoded)),
    );
  } catch {
    throw new Error("Feedback worker attestation payload is malformed");
  }
}

/**
 * Fail closed across every Worker registered on the feedback queue. Replicas
 * may agree; one legacy, corrupt, or differently configured replica invalidates
 * the set because BullMQ is free to give the paid job to any of them.
 */
export function attestFeedbackWorkers(
  workers: readonly BullMqWorkerInfo[],
  expected: FeedbackWorkerControlProfile,
): FeedbackWorkerAttestation {
  if (workers.length === 0) {
    return {
      status: "absent",
      registeredWorkerCount: 0,
      malformedWorkerCount: 0,
      observedProfiles: [],
      issue: "No feedback worker is registered in Redis.",
    };
  }

  const observedProfiles: FeedbackWorkerControlProfile[] = [];
  let malformedWorkerCount = 0;
  for (const worker of workers) {
    try {
      observedProfiles.push(
        parseFeedbackWorkerRegistrationName(
          registrationNameFromBullMqWorker(worker),
        ),
      );
    } catch {
      malformedWorkerCount += 1;
    }
  }

  const uniqueProfiles = deduplicateProfiles(observedProfiles);
  if (malformedWorkerCount > 0) {
    return {
      status: "malformed",
      registeredWorkerCount: workers.length,
      malformedWorkerCount,
      observedProfiles: uniqueProfiles,
      issue:
        "At least one registered feedback worker has no valid v3 control attestation. Restart every feedback worker from the current build before running a rehearsal.",
    };
  }
  if (uniqueProfiles.length !== 1) {
    return {
      status: "mismatch",
      registeredWorkerCount: workers.length,
      malformedWorkerCount: 0,
      observedProfiles: uniqueProfiles,
      issue:
        "Registered feedback workers disagree on their model/provider/transport control profile. Restart every feedback worker with one identical treatment before running a rehearsal.",
    };
  }

  const [observed] = uniqueProfiles;
  if (!observed || !sameProfile(observed, expected)) {
    return {
      status: "mismatch",
      registeredWorkerCount: workers.length,
      malformedWorkerCount: 0,
      observedProfiles: uniqueProfiles,
      issue:
        "The registered feedback worker control profile disagrees with the running API configuration. Restart both processes with the same model and transport controls before running a rehearsal.",
    };
  }

  return {
    status: "verified",
    registeredWorkerCount: workers.length,
    malformedWorkerCount: 0,
    observedProfiles: uniqueProfiles,
    issue: null,
  };
}

/**
 * Decorators are evaluated before Nest can inject ConfigService. The worker
 * entrypoint loads dotenv through `instrumentation.ts` before importing this
 * module, so this one centralized startup boundary resolves the same validated
 * FEEDBACK_* vocabulary directly from the raw environment.
 */
export function createFeedbackWorkerRegistrationNameFromEnvironment(
  environment: NodeJS.ProcessEnv,
): string {
  return createFeedbackWorkerRegistrationName(
    resolveFeedbackWorkerControlProfile({
      extractionStub: readEnvironmentBoolean(
        environment.FEEDBACK_EXTRACTION_STUB,
        "FEEDBACK_EXTRACTION_STUB",
      ),
      model: emptyToUndefined(environment.FEEDBACK_EXTRACTION_MODEL),
      extractionReasoningEffort: emptyToUndefined(
        environment.FEEDBACK_EXTRACTION_REASONING_EFFORT,
      ),
      replyReasoningEffort: emptyToUndefined(
        environment.FEEDBACK_REPLY_REASONING_EFFORT,
      ),
      attentionReasoningEffort: emptyToUndefined(
        environment.FEEDBACK_ATTENTION_REASONING_EFFORT,
      ),
      serviceTier: emptyToUndefined(
        environment.FEEDBACK_EXTRACTION_SERVICE_TIER,
      ),
      transportMode: emptyToUndefined(environment.TRANSPORT_MODE),
      simulatedTransportFaultMode: emptyToUndefined(
        environment.FEEDBACK_SIMULATED_TRANSPORT_FAULT_MODE,
      ),
      simulatedTransportFaultPercent: emptyToUndefined(
        environment.FEEDBACK_SIMULATED_TRANSPORT_FAULT_PERCENT,
      ),
      simulatedTransportSeed: emptyToUndefined(
        environment.FEEDBACK_SIMULATED_TRANSPORT_SEED,
      ),
      simulatedTransportMaxDelayMs: emptyToUndefined(
        environment.FEEDBACK_SIMULATED_TRANSPORT_MAX_DELAY_MS,
      ),
    }),
  );
}

function registrationNameFromBullMqWorker(worker: BullMqWorkerInfo): string {
  if (typeof worker.rawname !== "string") {
    throw new Error("BullMQ worker registration has no raw client name");
  }
  const separatorIndex = worker.rawname.lastIndexOf(
    BULLMQ_NAMED_WORKER_SEPARATOR,
  );
  if (separatorIndex < 0) {
    throw new Error("BullMQ worker registration is unnamed");
  }
  return worker.rawname.slice(
    separatorIndex + BULLMQ_NAMED_WORKER_SEPARATOR.length,
  );
}

function assertAdapterMatchesModel(
  profile: FeedbackWorkerControlProfile,
): FeedbackWorkerControlProfile {
  const adapter = assistantModelAdapter(profile.model);
  if (
    adapter.provider !== profile.provider ||
    adapter.providerModelId !== profile.providerModelId
  ) {
    throw new Error("Feedback worker model adapter is internally inconsistent");
  }
  return profile;
}

function deduplicateProfiles(
  profiles: readonly FeedbackWorkerControlProfile[],
): FeedbackWorkerControlProfile[] {
  const unique = new Map<string, FeedbackWorkerControlProfile>();
  for (const profile of profiles) {
    unique.set(JSON.stringify(profile), profile);
  }
  return [...unique.values()];
}

function sameProfile(
  left: FeedbackWorkerControlProfile,
  right: FeedbackWorkerControlProfile,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readEnvironmentBoolean(
  value: string | undefined,
  name: string,
): boolean {
  const normalized = emptyToUndefined(value)?.toLowerCase();
  if (normalized === undefined || normalized === "false") {
    return false;
  }
  if (normalized === "true") {
    return true;
  }
  throw new Error(`${name} must be true or false, received "${value}"`);
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}
