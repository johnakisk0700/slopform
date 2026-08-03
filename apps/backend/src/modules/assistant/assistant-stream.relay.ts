import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

import type { Environment } from "../../infrastructure/config/environment.js";
import { redisConnectionFromUrl } from "../../infrastructure/queue/redis-connection.js";

/**
 * The relay that carries a turn's live output from the worker to the HTTP
 * process.
 *
 * Generation runs in `dev:worker` and the SSE response is served by `dev:http`;
 * they are separate processes, so tokens can only cross through a broker. Redis
 * is already a hard dependency of the queue, and a Redis *stream* — rather than
 * pub/sub — is what lets a reader that connects late, or reconnects after a
 * dropped mobile link, replay from an offset instead of starting blind.
 *
 * Every entry carries the **accumulated prefix**, not a delta. That costs a few
 * more bytes than strictly necessary and buys two things: a reader may drop any
 * number of entries and still be correct, and a reader joining mid-turn needs
 * only the newest entry rather than every entry since the start.
 *
 * Nothing here is authoritative. The persisted turn is the source of truth and
 * the UI must be correct with this relay entirely absent — see
 * `docs/backend/mechanisms/assistant-streaming.md`.
 */

/** Long enough to outlive the 120s generation timeout and a slow reconnect. */
const STREAM_TTL_SECONDS = 600;
/** Only the tail matters, because entries carry accumulated prefixes. */
const STREAM_MAX_ENTRIES = 64;
/** How long a follower blocks on Redis before looping to re-check its signal. */
const READ_BLOCK_MS = 2_000;

export type AssistantStreamEvent =
  | { readonly kind: "reset" }
  | { readonly kind: "text"; readonly accumulated: string }
  | { readonly kind: "reasoning"; readonly accumulated: string }
  /**
   * What the turn is doing to the database, as a JSON array of
   * `AssistantToolActivity`.
   *
   * A third kind rather than a line folded into `reasoning`: that channel is
   * the model's own account of itself, and this is ours. It obeys the same
   * accumulated-prefix rule as the other two — the payload is always the whole
   * list, so a reader that drops frames is still correct on the next one.
   */
  | { readonly kind: "tools"; readonly accumulated: string }
  | { readonly kind: "done" };

function streamKey(turnId: string, attempt: number): string {
  return `assistant:stream:${turnId}:${attempt}`;
}

@Injectable()
export class AssistantStreamRelay implements OnModuleDestroy {
  private readonly logger = new Logger(AssistantStreamRelay.name);
  private readonly publisher: Redis;
  /** Blocking reads monopolise a connection, so followers never share one. */
  private readonly followers = new Set<Redis>();

  constructor(private readonly config: ConfigService<Environment, true>) {
    this.publisher = new Redis({
      ...redisConnectionFromUrl(this.config.get("REDIS_URL", { infer: true })),
      maxRetriesPerRequest: 1,
      lazyConnect: true,
    });
    // A relay outage must never surface as a failed turn, so its errors are
    // logged here rather than left to become unhandled rejections.
    this.publisher.on("error", (error: Error) => {
      this.logger.warn({
        event: "assistant.stream.publisher_error",
        error: { name: error.name },
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    for (const follower of this.followers) follower.disconnect();
    this.followers.clear();
    this.publisher.disconnect();
  }

  /**
   * Records one frame of live output. Best-effort by contract: the caller is a
   * generation the queue is accountable for, and losing an accelerator frame is
   * never a reason to fail it.
   */
  async publish(
    turnId: string,
    attempt: number,
    event: AssistantStreamEvent,
  ): Promise<void> {
    const key = streamKey(turnId, attempt);
    try {
      await this.publisher
        .multi()
        .xadd(
          key,
          "MAXLEN",
          "~",
          STREAM_MAX_ENTRIES,
          "*",
          "kind",
          event.kind,
          "text",
          event.kind === "done" || event.kind === "reset"
            ? ""
            : event.accumulated,
        )
        .expire(key, STREAM_TTL_SECONDS)
        .exec();
    } catch (error) {
      this.logger.warn({
        event: "assistant.stream.publish_failed",
        turnId,
        attempt,
        error: { name: error instanceof Error ? error.name : "UnknownError" },
      });
    }
  }

  /**
   * Replays everything recorded for this attempt, then follows until the turn
   * signals `done` or the caller aborts.
   *
   * Starting at `0-0` rather than `$` is the whole point of using a stream: a
   * client that opens the connection after generation began still receives the
   * text produced before it arrived, without a separate catch-up request.
   */
  async *follow(
    turnId: string,
    attempt: number,
    signal: AbortSignal,
  ): AsyncGenerator<AssistantStreamEvent> {
    const key = streamKey(turnId, attempt);
    const follower = new Redis({
      ...redisConnectionFromUrl(this.config.get("REDIS_URL", { infer: true })),
      maxRetriesPerRequest: null,
      lazyConnect: true,
    });
    follower.on("error", () => undefined);
    this.followers.add(follower);

    let cursor = "0-0";
    try {
      while (!signal.aborted) {
        const response = (await follower.xread(
          "BLOCK",
          READ_BLOCK_MS,
          "STREAMS",
          key,
          cursor,
        )) as [string, [string, string[]][]][] | null;

        if (!response) continue;

        for (const [, entries] of response) {
          for (const [id, fields] of entries) {
            cursor = id;
            const event = toEvent(fields);
            if (!event) continue;
            yield event;
            if (event.kind === "done") return;
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.logger.warn({
          event: "assistant.stream.follow_failed",
          turnId,
          attempt,
          error: {
            name: error instanceof Error ? error.name : "UnknownError",
          },
        });
      }
      throw error;
    } finally {
      this.followers.delete(follower);
      follower.disconnect();
    }
  }
}

/** Redis returns flat `[field, value, ...]`; unknown shapes are ignored. */
function toEvent(fields: readonly string[]): AssistantStreamEvent | null {
  let kind: string | undefined;
  let text = "";
  for (let index = 0; index + 1 < fields.length; index += 2) {
    if (fields[index] === "kind") kind = fields[index + 1];
    if (fields[index] === "text") text = fields[index + 1] ?? "";
  }

  if (kind === "done") return { kind: "done" };
  if (kind === "reset") return { kind: "reset" };
  if (kind === "text") return { kind: "text", accumulated: text };
  if (kind === "reasoning") return { kind: "reasoning", accumulated: text };
  if (kind === "tools") return { kind: "tools", accumulated: text };
  return null;
}
