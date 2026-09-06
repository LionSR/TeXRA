/**
 * The Promise edge of the auth subsystem's Effect programs (Effect 4 runtime
 * PRD, R1 and R7): one typed failure for the host ports those programs call,
 * and the settle-fold every Promise-facing auth surface shares. The run edge
 * itself is installed by the host entry ({@link installAuthProgramEdge}), so
 * the only `Effect.run*` site in the subsystem lives in host code at the
 * sanctioned boundary, not here.
 */
import { Cause, Data, Deferred, Effect, Exit, Option, Semaphore } from 'effect';

/**
 * A host port (secret storage), an SDK call, or a provider policy rejected.
 * `cause` is that caller's own error; the Promise edge re-throws it
 * unchanged, so every `instanceof` and message check a host makes still
 * holds.
 */
export class AuthPortError extends Data.TaggedError('AuthPortError')<{
  readonly cause: unknown;
}> {}

/** Adapt one Promise port call; its rejection becomes an {@link AuthPortError}. */
export function callPort<A>(
  call: () => Promise<A>,
): Effect.Effect<A, AuthPortError> {
  return Effect.tryPromise({
    try: call,
    catch: (cause) => new AuthPortError({ cause }),
  });
}

/**
 * Serialized storage writes with an idle barrier — what a coordinator's
 * `p-queue` serializer was: one write at a time, a write that holds the
 * permit runs to completion, and a reader can wait for every write queued
 * before it. A single-permit semaphore alone cannot give the barrier: it
 * frees its permit before it wakes its waiters, so a fiber that just
 * released it and asks again barges ahead of a queued write. The barrier
 * therefore counts queued writes itself and waits on a `Deferred` the last
 * one settles; it depends on no scheduler wake ordering.
 */
export class SerializedWrites {
  private readonly permit = Semaphore.makeUnsafe(1);
  private queued = 0;
  private idle: Deferred.Deferred<void> | null = null;

  /**
   * Queue `write` behind the permit. `onQueue` runs in the same synchronous
   * segment that counts the write as queued — before any fiber boundary — so
   * a caller can publish that a write is coming (bump a generation) atomically
   * with queueing it, as a synchronous `queue.add()` used to.
   */
  run<A, E>(
    write: Effect.Effect<A, E>,
    onQueue?: () => void,
  ): Effect.Effect<A, E> {
    return Effect.suspend(() => {
      onQueue?.();
      this.queued += 1;
      // Interruption is observed while waiting for the permit, never once it
      // is held. A port write cannot be cancelled — `callPort` never aborts
      // the Promise it wraps — so an interruptible write would release the
      // permit and leave the barrier idle while the storage write is still
      // pending, and the next write would run beside it. The p-queue job it
      // replaces always finished, with later jobs queued behind it.
      return this.permit
        .withPermits(1)(Effect.uninterruptible(write))
        .pipe(Effect.ensuring(Effect.sync(() => this.dequeue())));
    });
  }

  /**
   * Whether a write is queued behind the one holding the permit. Read from
   * inside that write, once its own port call has returned, it says the value
   * just written is about to be replaced — what a p-queue caller could see in
   * the version counter because the next job started synchronously on the
   * previous one's return, and a fiber that bumps under the permit cannot.
   */
  get hasWaiters(): boolean {
    return this.queued > 1;
  }

  private dequeue(): void {
    this.queued -= 1;
    if (this.queued === 0 && this.idle) {
      const idle = this.idle;
      this.idle = null;
      Deferred.doneUnsafe(idle, Effect.void);
    }
  }

  /** Wait until every write queued before this call has run. */
  readonly awaitIdle = Effect.fn('SerializedWrites.awaitIdle')(function* (
    this: SerializedWrites,
  ) {
    while (this.queued > 0) {
      this.idle ??= Deferred.makeUnsafe<void>();
      yield* Deferred.await(this.idle);
    }
  });
}

function rethrowPortCause(error: unknown): never {
  throw error instanceof AuthPortError ? error.cause : error;
}

/**
 * Settles an auth program as an `Exit`, for the Promise-facing surfaces that
 * settle through {@link runAuthProgram}. Installed like the process roots:
 * exactly once per process, by the host entry, as
 * `(program) => effectRuntime().runPromiseExit(program)` — which keeps the
 * `Effect.run*` call itself in boundary code (PRD R1).
 */
export type AuthProgramEdge = <A, E>(
  program: Effect.Effect<A, E>,
) => Promise<Exit.Exit<A, E>>;

let authProgramEdge: AuthProgramEdge | null = null;

/** Install the process-wide run edge for auth programs. */
export function installAuthProgramEdge(edge: AuthProgramEdge): void {
  authProgramEdge = edge;
}

/**
 * Run one auth program on the installed edge and settle it as a Promise.
 * An expected failure reaches `rethrow`, which re-mints it as the error the
 * caller matches on — by default the port's own error, unwrapped. Defects
 * and interruption propagate as they are.
 */
export async function runAuthProgram<A, E>(
  program: Effect.Effect<A, E>,
  rethrow: (error: E) => never = rethrowPortCause,
): Promise<A> {
  if (!authProgramEdge) {
    throw new Error(
      'Auth program edge not installed: the host entry installs it beside the process runtime.',
    );
  }
  const exit = await authProgramEdge(program);
  if (Exit.isSuccess(exit)) return exit.value;
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isSome(failure)) return rethrow(failure.value);
  throw Cause.squash(exit.cause);
}
