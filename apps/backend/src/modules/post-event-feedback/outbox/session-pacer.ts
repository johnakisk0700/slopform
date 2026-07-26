/**
 * Shared-session send pacing. WordPress and this backend share one Wasender
 * session, so outbound work must serialize with a minimum interval plus jitter
 * rather than firing one promise per participant.
 */
export const FEEDBACK_SEND_MIN_INTERVAL_MS = 1_500;
export const FEEDBACK_SEND_JITTER_MS = 500;

export type FeedbackSessionPacerOptions = {
  readonly minIntervalMs?: number;
  readonly jitterMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
};

export class FeedbackSessionPacer {
  private readonly minIntervalMs: number;
  private readonly jitterMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private lastSendAt: number | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(options: FeedbackSessionPacerOptions = {}) {
    this.minIntervalMs = options.minIntervalMs ?? FEEDBACK_SEND_MIN_INTERVAL_MS;
    this.jitterMs = options.jitterMs ?? FEEDBACK_SEND_JITTER_MS;
    this.now = options.now ?? Date.now;
    this.sleep =
      options.sleep ??
      ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  /**
   * Waits until the shared session may send again. Concurrent callers serialize
   * through an internal chain so the minimum interval is measured between
   * actual send slots, not between wait starts.
   */
  async waitTurn(): Promise<{ readonly waitedMs: number }> {
    const turn = this.chain.then(async () => {
      const jitter =
        this.jitterMs <= 0
          ? 0
          : Math.floor(this.random() * (this.jitterMs + 1));
      const requiredGap = this.minIntervalMs + jitter;
      const waitedMs =
        this.lastSendAt === undefined
          ? 0
          : Math.max(0, requiredGap - (this.now() - this.lastSendAt));
      if (waitedMs > 0) {
        await this.sleep(waitedMs);
      }
      this.lastSendAt = this.now();
      return { waitedMs };
    });

    this.chain = turn.then(
      () => undefined,
      () => undefined,
    );
    return turn;
  }
}
