/**
 * The shared PKCE permit, formerly `SupabaseClient.runPkceOperation`'s
 * semaphore. Auth-js keeps each verifier in a flow-specific slot, while this
 * single permit prevents an older callback exchange from racing OAuth
 * initialization in the same extension host. The host composes its exchange
 * or sign-in program under the permit and runs it at its own edge, so the
 * operation's own failure reaches the caller unchanged.
 */
import { type Effect, Semaphore } from 'effect';

const pkceOperations = Semaphore.makeUnsafe(1);

/** Run `operation` under the shared PKCE permit. */
export function withPkcePermit<A, E>(
  operation: Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return pkceOperations.withPermits(1)(operation);
}
