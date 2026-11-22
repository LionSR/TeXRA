// How code outside Effect (a React callback, a key handler, a signal handler)
// runs Effect work for one owner: a mounted component, the chat, or the
// process until its shutdown. Each owner is a scope, and the work started
// through its runner ends with that scope.

// Third-party imports
import { Effect, Exit, Scope } from 'effect';

// Local imports
import type { Sessions } from '@texra-ai/worldline';
import {
  scopedFork,
  type ProcessRuntime,
  type ProcessServices,
  type ScopedFork,
} from '@texra-ai/worldline/host';

/** What the process runtime serves to the work a runner starts. */
type Services = ProcessServices | Sessions;

export interface ScopeRunner {
  /** The owner's scope, for a program that forks or acquires in it from
   *  inside Effect (`Effect.forkIn`). */
  readonly scope: Scope.Scope;
  /**
   * Start `effect` on a fiber the owner's scope holds: closing the scope
   * interrupts it, and once the scope has closed nothing starts. A failure
   * or defect the effect leaves unhandled is logged once; a caller that
   * shows a failure handles it inside the effect.
   */
  readonly fork: ScopedFork<Services>;
  /**
   * Run `effect` to its end before returning, with the owner's scope as its
   * `Scope`: what it acquires (a `FiberHandle`, a finalizer, a scoped fork)
   * is released when the owner's scope closes. It throws when the effect
   * fails or has to wait.
   */
  readonly sync: <A, E>(
    effect: Effect.Effect<A, E, Services | Scope.Scope>,
  ) => A;
  /** A runner over a new scope under this one, which `close` or this
   *  owner's own close ends, whichever comes first. */
  readonly child: () => ScopeRunner & { readonly close: () => void };
}

/** The runner of `scope`, over the process runtime's services. */
export function scopeRunner(
  runtime: ProcessRuntime,
  scope: Scope.Scope,
): ScopeRunner {
  const sync: ScopeRunner['sync'] = (effect) =>
    runtime.runSync(Scope.provide(effect, scope));
  const fork = sync(scopedFork<Services>());
  return {
    scope,
    fork,
    sync,
    child: () => {
      const inner = sync(Scope.fork(scope));
      return {
        ...scopeRunner(runtime, inner),
        // The close is this owner's work, not the child's: a fiber of the
        // scope being closed would be interrupted by its own close.
        close: () => {
          fork(Scope.close(inner, Exit.void));
        },
      };
    },
  };
}
