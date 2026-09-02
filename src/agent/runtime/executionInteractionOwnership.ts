/**
 * Which host-interaction generation owns each live execution.
 *
 * A host attaches interaction surfaces (presentation host, approval adapter,
 * terminal-result presenter) once per run generation, and must keep them
 * attached while any execution that inherited them is still alive — a detached
 * child outliving its stopped root still needs an answerable approval path —
 * without a later generation inheriting the earlier one's runs. Ownership is
 * decided from registry facts (handle registration, child-activation
 * reservation, parent/child stream lineage), so it lives here rather than in
 * each host. Design note: `docs/design/2026-08-01-execution-interaction-ownership.md`.
 *
 * The two registry facts arrive by different routes, and deliberately so.
 * Handle registration is a genuine multi-consumer registry channel (the
 * desktop window title reads it too), so scopes subscribe to it. Child
 * activation has exactly one consumer — this index — so the registry calls
 * {@link ExecutionInteractionOwnership.observeChildActivation} directly rather
 * than maintaining a listener set for a single subscriber.
 */

import { DisposableStore } from '@platform/disposable';
import type { StreamTabId } from '@shared/schemas';
import type { AgentExecutionHandle } from './ExecutionHandle';
import type {
  ChildExecutionActivation,
  ExecutionRegistry,
} from './executionRegistry';

/**
 * One owner generation. The scope object is its own owner token, so the
 * ownership maps below key on the scope itself rather than on a parallel
 * identity.
 */
interface ExecutionInteractionScope {
  /**
   * Claim `executionId` and everything it goes on to spawn: once the run's
   * handle is tracked, its child stream is owned too, so descendants join this
   * scope through stream lineage.
   */
  claim(executionId: string): void;

  /**
   * State that no further root claims are coming. The scope releases once its
   * last claimed handle is untracked and its last reserved child activation is
   * released — immediately, when none is left.
   */
  finish(): void;

  /** Drop every claim now and fire the release callback (idempotent). */
  release(): void;
}

function deleteOwnedEntries<K>(
  owners: Map<K, ExecutionInteractionScope>,
  scope: ExecutionInteractionScope,
): void {
  for (const [key, owner] of owners) {
    if (owner === scope) owners.delete(key);
  }
}

/** Session-wide index of interaction ownership, one per {@link ExecutionRegistry}. */
export class ExecutionInteractionOwnership {
  private readonly executionOwners = new Map<
    string,
    ExecutionInteractionScope
  >();
  private readonly streamOwners = new Map<
    StreamTabId,
    ExecutionInteractionScope
  >();

  /** One per open scope, added on open and dropped on release. */
  private readonly activationObservers = new Set<
    (activation: ChildExecutionActivation, active: boolean) => void
  >();

  constructor(private readonly registry: ExecutionRegistry) {}

  /**
   * Apply one child-activation reservation or release to every open scope.
   * Called by {@link ExecutionRegistry} as it reserves, releases, and (on
   * disposal) drops activations.
   */
  observeChildActivation(
    activation: ChildExecutionActivation,
    active: boolean,
  ): void {
    for (const observe of [...this.activationObservers]) {
      observe(activation, active);
    }
  }

  /**
   * Drop every open scope's activation observer, so none survives the
   * registry's disposal. The registry calls this beside the `clear()` of its
   * own listener channels, which is where that invariant used to be readable
   * for this one before the registry stopped holding it.
   *
   * The owner maps need no clear: both routes that read them are severed here
   * (the registration listeners are cleared by the same `dispose()`, and
   * `claim()` resolves through a `handles` map that is already empty), and
   * they die with the registry that owns this index. Scopes stay releasable
   * on purpose — a later `release()` still fires its `onRelease`, which is how
   * a host detaches the interaction surfaces it attached.
   */
  dispose(): void {
    this.activationObservers.clear();
  }

  /** Start an owner generation. `onRelease` fires exactly once, at release. */
  open(onRelease: () => void): ExecutionInteractionScope {
    // Live execution id → its child stream, so untracking an execution can
    // also drop the stream-owner entry its registration wrote.
    const liveExecutions = new Map<string, StreamTabId>();
    const pendingActivations = new Set<string>();
    const disposables = new DisposableStore();
    let finished = false;
    let released = false;

    const releaseIfIdle = (): void => {
      if (!finished) return;
      if (liveExecutions.size > 0 || pendingActivations.size > 0) return;
      scope.release();
    };

    const observeRegistration = (
      executionId: string,
      handle: AgentExecutionHandle | undefined,
    ): void => {
      if (!handle) {
        if (this.executionOwners.get(executionId) === scope) {
          this.executionOwners.delete(executionId);
          const childStreamId = liveExecutions.get(executionId);
          liveExecutions.delete(executionId);
          if (
            childStreamId !== undefined &&
            this.streamOwners.get(childStreamId) === scope
          ) {
            this.streamOwners.delete(childStreamId);
          }
        }
        releaseIfIdle();
        return;
      }

      const owned =
        this.executionOwners.get(executionId) === scope ||
        this.streamOwners.get(handle.parentStreamId) === scope;
      if (!owned) {
        // A replacement handle owned by another generation: drop the live
        // claim rather than holding this generation's surfaces open for it.
        liveExecutions.delete(executionId);
        releaseIfIdle();
        return;
      }

      this.executionOwners.set(executionId, scope);
      liveExecutions.set(executionId, handle.childStreamId);
      this.streamOwners.set(handle.childStreamId, scope);
    };

    const observeActivation = (
      activation: ChildExecutionActivation,
      active: boolean,
    ): void => {
      if (active) {
        if (this.streamOwners.get(activation.parentStreamId) !== scope) return;
        // A child loop starts synchronously and builds its first handle
        // asynchronously; the reservation keeps that gap from reading as idle.
        pendingActivations.add(activation.executionId);
        this.executionOwners.set(activation.executionId, scope);
        this.streamOwners.set(activation.childStreamId, scope);
        return;
      }

      pendingActivations.delete(activation.executionId);
      if (
        !this.registry.getHandle(activation.executionId) &&
        this.executionOwners.get(activation.executionId) === scope
      ) {
        this.executionOwners.delete(activation.executionId);
        if (this.streamOwners.get(activation.childStreamId) === scope) {
          this.streamOwners.delete(activation.childStreamId);
        }
      }
      releaseIfIdle();
    };

    const scope: ExecutionInteractionScope = {
      claim: (executionId): void => {
        this.executionOwners.set(executionId, scope);
        const handle = this.registry.getHandle(executionId);
        if (handle) observeRegistration(executionId, handle);
      },
      finish: (): void => {
        finished = true;
        releaseIfIdle();
      },
      release: (): void => {
        if (released) return;
        released = true;
        try {
          disposables.dispose();
        } finally {
          deleteOwnedEntries(this.executionOwners, scope);
          deleteOwnedEntries(this.streamOwners, scope);
          onRelease();
        }
      },
    };

    disposables.add(this.registry.addRegistrationListener(observeRegistration));
    this.activationObservers.add(observeActivation);
    disposables.add(() => this.activationObservers.delete(observeActivation));
    return scope;
  }
}
