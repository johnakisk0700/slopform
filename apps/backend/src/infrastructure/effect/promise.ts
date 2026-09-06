import { Cause, Effect, Exit } from "effect";

/** Adapt a Nest service call without replacing its rejection or sync throw. */
export function attemptPromise<A>(
  call: () => Promise<A>,
): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: call, catch: (error) => error });
}

/** BullMQ and callers classify the original error, not Effect's FiberFailure. */
export async function runWithOriginalError<A, E>(
  flow: Effect.Effect<A, E>,
): Promise<A> {
  const exit = await Effect.runPromiseExit(flow);
  if (Exit.isFailure(exit)) throw Cause.squash(exit.cause);
  return exit.value;
}
