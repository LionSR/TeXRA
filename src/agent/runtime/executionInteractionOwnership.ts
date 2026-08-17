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
 * each host. Design note: `docs/design/execution-interaction-ownership.md`.
 */

import { DisposableStore } from '@platform/disposable';
import type { StreamTabId } from '@shared/schemas';
import type { AgentExecutionHandle } from './ExecutionHandle';
import type {
  ChildExecutionActivation,
  ExecutionRegistry,
} from './executionRegistry';

/**
 * One owner generation. The scope object is its own owner token, so
 * {@link ExecutionInteractionOwnership.ownerOf} can answer with the scope
 * itself instead of a parallel identity.
 */
export interface ExecutionInteractionScope {
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

  constructor(private readonly registry: ExecutionRegistry) {}

  /** The generation owning `executionId`, or undefined when it is unclaimed. */
  ownerOf(executionId: string): ExecutionInteractionScope | undefined {
    return this.executionOwners.get(executionId);
  }

  /** Start an owner generation. `onRelease` fires exactly once, at release. */
  open(onRelease: () => void): ExecutionInteractionScope {
    const liveExecutions = new Set<string>();
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
          liveExecutions.delete(executionId);
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
      liveExecutions.add(executionId);
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
    disposables.add(
      this.registry.addChildActivationListener(observeActivation),
    );
    return scope;
  }
}
