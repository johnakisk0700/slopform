/**
 * Maximum paid model requests that one worker process may keep in flight.
 *
 * Neither OpenAI nor OpenRouter publishes one stable concurrency number that
 * applies to every model and account. Five is therefore a deliberately
 * conservative product default, not a provider quota. The production compose
 * topology runs one worker, so this is deployment-wide today; adding worker
 * replicas must add a distributed semaphore or each replica will get five.
 */
export const PROVIDER_CALL_CONCURRENCY_LIMIT = 5;

type PendingAcquire = () => void;

/** FIFO semaphore shared by every model boundary in this Node process. */
export class ProviderCallLimiter {
  private active = 0;
  private readonly pending: PendingAcquire[] = [];

  constructor(readonly limit: number = PROVIDER_CALL_CONCURRENCY_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error(
        "Provider call concurrency limit must be a positive integer",
      );
    }
  }

  async run<T>(call: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await call();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      this.pending.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    const next = this.pending.shift();
    next?.();
  }
}

const sharedProviderCallLimiter = new ProviderCallLimiter();

export function withProviderCallSlot<T>(call: () => Promise<T>): Promise<T> {
  return sharedProviderCallLimiter.run(call);
}
