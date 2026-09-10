/**
 * Which host-interaction generation owns each live run.
 *
 * A host attaches interaction surfaces (presentation host, approval adapter,
 * terminal-result presenter) once per run generation, and must keep them
 * attached while any run that inherited them is still alive — a detached
 * child outliving its stopped root still needs an answerable approval path —
 * without a later generation inheriting the earlier one's runs. Ownership is
 * decided from registry facts (handle registration, child-activation
 * reservation, the parent edge), so it lives here rather than in
 * each host. Design note: `docs/design/2026-08-01-run-interaction-ownership.md`.
 *
 * The two registry facts arrive by different routes, and deliberately so.
 * Handle registration is a genuine multi-consumer registry channel (the
 * desktop window title reads it too), so scopes subscribe to it. Child
 * activation has exactly one consumer — this index — so the registry calls
 * {@link RunInteractionOwnership.observeChildActivation} directly rather
 * than maintaining a listener set for a single subscriber.
 */

import { DisposableStore } from '@platform/disposable';
import type { RunId } from '@shared/schemas';
import type { RunHandle } from './RunHandle';
import type { ChildRunActivation, RunRegistry } from './runRegistry';

/**
 * One owner generation. The scope object is its own owner token, so the
 * ownership maps below key on the scope itself rather than on a parallel
 * identity.
 */
interface RunInteractionScope {
  /**
   * Claim `runId` and everything it goes on to spawn: once the run's
   * handle is tracked, the runs it parents are owned too, so descendants join
   * this scope through the parent edge.
   */
  claim(runId: RunId): void;

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
  owners: Map<K, RunInteractionScope>,
  scope: RunInteractionScope,
): void {
  for (const [key, owner] of owners) {
    if (owner === scope) owners.delete(key);
  }
}

/** Session-wide index of interaction ownership, one per {@link RunRegistry}. */
export class RunInteractionOwnership {
  /** Run id → the generation that owns its interaction surfaces. */
  private readonly runOwners = new Map<RunId, RunInteractionScope>();

  /** One per open scope, added on open and dropped on release. */
  private readonly activationObservers = new Set<
    (activation: ChildRunActivation, active: boolean) => void
  >();

  constructor(private readonly registry: RunRegistry) {}

  /**
   * Apply one child-activation reservation or release to every open scope.
   * Called by {@link RunRegistry} as it reserves, releases, and (on
   * disposal) drops activations.
   */
  observeChildActivation(
    activation: ChildRunActivation,
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
   * The owner map needs no clear: both routes that read it are severed here
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
  open(onRelease: () => void): RunInteractionScope {
    /** Run ids this generation currently holds a tracked handle for. */
    const liveRuns = new Set<RunId>();
    const pendingActivations = new Set<RunId>();
    const disposables = new DisposableStore();
    let finished = false;
    let released = false;

    const releaseIfIdle = (): void => {
      if (!finished) return;
      if (liveRuns.size > 0 || pendingActivations.size > 0) return;
      scope.release();
    };

    const observeRegistration = (
      runId: RunId,
      handle: RunHandle | undefined,
    ): void => {
      if (!handle) {
        if (this.runOwners.get(runId) === scope) {
          this.runOwners.delete(runId);
          liveRuns.delete(runId);
        }
        releaseIfIdle();
        return;
      }

      const owned =
        this.runOwners.get(runId) === scope ||
        (handle.parent !== null && this.runOwners.get(handle.parent) === scope);
      if (!owned) {
        // A replacement handle owned by another generation: drop the live
        // claim rather than holding this generation's surfaces open for it.
        liveRuns.delete(runId);
        releaseIfIdle();
        return;
      }

      this.runOwners.set(runId, scope);
      liveRuns.add(runId);
    };

    const observeActivation = (
      activation: ChildRunActivation,
      active: boolean,
    ): void => {
      if (active) {
        if (this.runOwners.get(activation.parentRunId) !== scope) return;
        // A child loop starts synchronously and builds its first handle
        // asynchronously; the reservation keeps that gap from reading as idle.
        pendingActivations.add(activation.runId);
        this.runOwners.set(activation.runId, scope);
        return;
      }

      pendingActivations.delete(activation.runId);
      if (
        !this.registry.getHandle(activation.runId) &&
        this.runOwners.get(activation.runId) === scope
      ) {
        this.runOwners.delete(activation.runId);
      }
      releaseIfIdle();
    };

    const scope: RunInteractionScope = {
      claim: (runId): void => {
        this.runOwners.set(runId, scope);
        const handle = this.registry.getHandle(runId);
        if (handle) observeRegistration(runId, handle);
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
          deleteOwnedEntries(this.runOwners, scope);
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
