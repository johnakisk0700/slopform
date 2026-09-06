import { randomBytes } from "node:crypto";

import { Logger } from "@nestjs/common";

const SAFE_IDENTIFIER = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
/** Letter-start codes, or short digit-leading SQLSTATE values such as 23505/40P01. */
const SAFE_ERROR_CODE =
  /^(?:[A-Za-z][A-Za-z0-9._-]{0,63}|[0-9][A-Za-z0-9]{0,7})$/u;
const CONTEXT_IDS = [
  "conversationId",
  "campaignId",
  "ingressId",
  "outboxId",
] as const;
const CONTEXT_INTS = ["workRevision", "executionEpoch", "attempt"] as const;

export const FEEDBACK_OPERATION_EVENT = "feedback.operation";
let fallbackRunSequence = 0;

/**
 * Best-effort void Logger facade so sink failures cannot abort a use case.
 * Do not pass to `Logger.overrideLogger`.
 */
export class FeedbackLogger extends Logger {
  override log(message: unknown, ...optionalParams: unknown[]): void {
    this.emitSafe("log", message, optionalParams);
  }

  override error(message: unknown, ...optionalParams: unknown[]): void {
    this.emitSafe("error", message, optionalParams);
  }

  override warn(message: unknown, ...optionalParams: unknown[]): void {
    this.emitSafe("warn", message, optionalParams);
  }

  override debug(message: unknown, ...optionalParams: unknown[]): void {
    this.emitSafe("debug", message, optionalParams);
  }

  override verbose(message: unknown, ...optionalParams: unknown[]): void {
    this.emitSafe("verbose", message, optionalParams);
  }

  override fatal(message: unknown, ...optionalParams: unknown[]): void {
    this.emitSafe("fatal", message, optionalParams);
  }

  private emitSafe(
    level: "log" | "error" | "warn" | "debug" | "verbose" | "fatal",
    message: unknown,
    optionalParams: readonly unknown[],
  ): void {
    try {
      super[level](message, ...optionalParams);
    } catch {
      // Observational only.
    }
  }
}

/** Named safe identifiers only — no extraData, text, phone, tokens, or prompts. */
export interface FeedbackOperationContext {
  readonly operation: string;
  readonly correlationId: string;
  readonly conversationId?: string;
  readonly campaignId?: string;
  readonly ingressId?: string;
  readonly outboxId?: string;
  readonly workRevision?: number;
  readonly executionEpoch?: number;
  readonly attempt?: number;
}

/**
 * Per-run observer: stage/settlement are instance state only. Emits
 * `feedback.operation`; never writes audit/outbox, enqueues, or chooses send.
 */
export class FeedbackOperationLog {
  private readonly runId = createRunId();
  private readonly startedAt = Date.now();
  private readonly fields: Record<string, string | number>;
  private stageName: string | undefined;
  private settled = false;

  constructor(
    private readonly logger: Pick<Logger, "log" | "error">,
    context: FeedbackOperationContext,
  ) {
    this.fields = snapshotContext(context);
  }

  /** Named safe IDs only; later emits include them. Does not mutate caller input. */
  enrich(
    ids: Omit<FeedbackOperationContext, "operation" | "correlationId">,
  ): void {
    if (this.settled) {
      return;
    }
    Object.assign(this.fields, copySafeIds(ids));
  }

  stage(name: string): void {
    if (this.settled) {
      return;
    }
    this.stageName = safeIdentifier(name) ?? "unknown";
    this.emit("log", "started");
  }

  complete(outcome: string): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.emit("log", "completed", {
      outcome: safeIdentifier(outcome) ?? "unknown",
    });
  }

  /** Optional `outcome` is caller classification (e.g. expected supersession). */
  failed(error: unknown, outcome?: string): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.emit("error", "failed", {
      ...safeErrorFields(error),
      ...(outcome === undefined
        ? {}
        : { outcome: safeIdentifier(outcome) ?? "unknown" }),
    });
  }

  private emit(
    level: "log" | "error",
    status: "started" | "completed" | "failed",
    extra: Record<string, string> = {},
  ): void {
    try {
      this.logger[level]({
        event: FEEDBACK_OPERATION_EVENT,
        runId: this.runId,
        ...this.fields,
        ...(this.stageName === undefined ? {} : { stage: this.stageName }),
        status,
        elapsedMs: Date.now() - this.startedAt,
        ...extra,
      });
    } catch {
      // A raw Logger sink must still not replace a business error.
    }
  }
}

function createRunId(): string {
  try {
    return randomBytes(6).toString("hex");
  } catch {
    // Correlation must survive an unavailable entropy source too.
    return `fallback-${process.pid}-${Date.now()}-${fallbackRunSequence++}`;
  }
}

function snapshotContext(context: FeedbackOperationContext) {
  return {
    operation: safeIdentifier(context.operation) ?? "unknown",
    correlationId: context.correlationId,
    ...copySafeIds(context),
  };
}

function copySafeIds(
  context: Omit<FeedbackOperationContext, "operation" | "correlationId">,
) {
  const fields: Record<string, string | number> = {};
  for (const key of CONTEXT_IDS) {
    const value = context[key];
    if (typeof value === "string") {
      fields[key] = value;
    }
  }
  for (const key of CONTEXT_INTS) {
    const value = context[key];
    if (typeof value === "number" && Number.isSafeInteger(value)) {
      fields[key] = value;
    }
  }
  return fields;
}

function safeIdentifier(value: unknown): string | undefined {
  try {
    return typeof value === "string" && SAFE_IDENTIFIER.test(value)
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorCode(value: unknown): string | undefined {
  try {
    const code =
      typeof value === "number" && Number.isSafeInteger(value)
        ? String(value)
        : value;
    return typeof code === "string" && SAFE_ERROR_CODE.test(code)
      ? code
      : undefined;
  } catch {
    return undefined;
  }
}

function readProperty(value: unknown, key: string): unknown {
  try {
    return value != null &&
      (typeof value === "object" || typeof value === "function")
      ? Reflect.get(value, key)
      : undefined;
  } catch {
    return undefined;
  }
}

function safeErrorFields(error: unknown) {
  // Never read message, stack, cause, or provider bodies.
  const errorName = safeIdentifier(readProperty(error, "name"));
  const errorCode = safeErrorCode(readProperty(error, "code"));
  return {
    ...(errorName === undefined ? {} : { errorName }),
    ...(errorCode === undefined ? {} : { errorCode }),
  };
}
