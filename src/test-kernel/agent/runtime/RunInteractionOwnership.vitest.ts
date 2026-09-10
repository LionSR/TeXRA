// Interaction-ownership index (D3/T5): which host-interaction generation owns
// each live run. Pins the release rule a host depends on — surfaces stay
// attached while any inheriting run is alive, and one generation never inherits
// another's runs. Design note: docs/design/2026-08-01-run-interaction-ownership.md.

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { RunRegistry } from '@agent/runtime/runRegistry';
import type { RunId } from '@shared/schemas';
import {
  testRunHandle,
  testRunRegistry,
} from '@test/support/runHandleFixtures';

const liveRegistries: RunRegistry[] = [];

afterEach(() => {
  for (const registry of liveRegistries.splice(0)) {
    registry.dispose();
  }
});

function createRegistry(): RunRegistry {
  const registry = testRunRegistry();
  liveRegistries.push(registry);
  return registry;
}

function trackRun(
  registry: RunRegistry,
  runId: string,
  parentRunId: RunId,
  childRunId: RunId,
): void {
  registry.track(
    testRunHandle({
      runId,
      parentRunId,
      childRunId,
      agent: 'test-agent',
    }),
  );
}

/** A fresh registry with a scope that has claimed and tracked 'root'. */
function openRootScope() {
  const registry = createRegistry();
  const onRelease = vi.fn();
  const scope = registry.interactionOwnership.open(onRelease);
  const rootRun = 'root-stream' as RunId;

  scope.claim('root');
  trackRun(registry, 'root', rootRun, rootRun);

  return { registry, onRelease, scope, rootRun };
}

describe('run interaction ownership', () => {
  it('releases only once the owner finished and its last run was untracked', () => {
    const { registry, onRelease, scope } = openRootScope();

    scope.finish();
    expect(onRelease).not.toHaveBeenCalled();

    registry.untrack('root');
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('releases immediately when a claimed run never reached the registry', () => {
    const registry = createRegistry();
    const onRelease = vi.fn();
    const scope = registry.interactionOwnership.open(onRelease);

    scope.claim('never-tracked');
    expect(onRelease).not.toHaveBeenCalled();

    scope.finish();
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('keeps a detached child of a finished root attached to its owner', () => {
    const { registry, onRelease, scope, rootRun } = openRootScope();

    // The child is never claimed by the host: it inherits through the stream
    // lineage of the root the host did claim.
    // The child is proved to have inherited the scope by the release rule
    // below: an unowned child would let the finished root release at once.
    trackRun(registry, 'child', rootRun, 'child-stream' as RunId);

    registry.untrack('root');
    scope.finish();
    expect(onRelease).not.toHaveBeenCalled();

    registry.untrack('child');
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('inherits a grandchild through the child stream it already owns', () => {
    const { registry, onRelease, scope, rootRun } = openRootScope();
    const childRun = 'child-stream' as RunId;

    trackRun(registry, 'child', rootRun, childRun);
    trackRun(
      registry,
      'grandchild',
      childRun,
      'grandchild-stream' as RunId,
    );

    registry.untrack('root');
    registry.untrack('child');
    scope.finish();
    expect(onRelease).not.toHaveBeenCalled();

    registry.untrack('grandchild');
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('holds the owner for the whole life of a child activation', () => {
    const { registry, onRelease, scope, rootRun } = openRootScope();
    const childRun = 'child-stream' as RunId;

    const releaseActivation = registry.reserveChildActivation({
      runId: 'child',
      parentRunId: rootRun,
      childRunId: childRun,
      interrupt: vi.fn(),
      detach: vi.fn(),
      isDetached: () => false,
    });
    registry.untrack('root');
    scope.finish();
    expect(onRelease).not.toHaveBeenCalled();

    // The activation holds the owner for the loop's whole life: across the
    // child's turn handles and the gaps between them, until the loop's own
    // disposer runs after its final delivery.
    trackRun(registry, 'child', rootRun, childRun);
    expect(onRelease).not.toHaveBeenCalled();
    registry.untrack('child');
    expect(onRelease).not.toHaveBeenCalled();

    releaseActivation();
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('releases the owner when a reserved child activation fails to start', () => {
    const { registry, onRelease, scope, rootRun } = openRootScope();
    const childRun = 'child-stream' as RunId;

    const releaseActivation = registry.reserveChildActivation({
      runId: 'child',
      parentRunId: rootRun,
      childRunId: childRun,
      interrupt: vi.fn(),
      detach: vi.fn(),
      isDetached: () => false,
    });
    registry.untrack('root');
    scope.finish();
    expect(onRelease).not.toHaveBeenCalled();

    releaseActivation();
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('does not let a later generation inherit or release an earlier one', () => {
    const registry = createRegistry();
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    const first = registry.interactionOwnership.open(releaseFirst);
    const firstRootRun = 'first-root' as RunId;

    first.claim('first-root');
    trackRun(registry, 'first-root', firstRootRun, firstRootRun);
    trackRun(
      registry,
      'first-child',
      firstRootRun,
      'first-child-stream' as RunId,
    );
    registry.untrack('first-root');
    first.finish();

    const second = registry.interactionOwnership.open(releaseSecond);
    const secondRootRun = 'second-root' as RunId;
    second.claim('second-root');
    trackRun(registry, 'second-root', secondRootRun, secondRootRun);
    registry.untrack('second-root');
    second.finish();

    expect(releaseSecond).toHaveBeenCalledOnce();
    expect(releaseFirst).not.toHaveBeenCalled();

    // The second generation's release must not strip the first's claims: the
    // first still holds its child, and releases only when that child goes.
    registry.untrack('first-child');
    expect(releaseFirst).toHaveBeenCalledOnce();
  });

  it('drops a run whose replacement handle another generation claimed', () => {
    const registry = createRegistry();
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    const first = registry.interactionOwnership.open(releaseFirst);
    const second = registry.interactionOwnership.open(releaseSecond);
    const rootRun = 'root-stream' as RunId;

    first.claim('root');
    trackRun(registry, 'root', rootRun, rootRun);
    // A resume in a later generation claims the same run id, then
    // registers its own handle for it.
    second.claim('root');
    trackRun(registry, 'root', rootRun, rootRun);

    first.finish();
    expect(releaseFirst).toHaveBeenCalledOnce();
    expect(releaseSecond).not.toHaveBeenCalled();

    second.finish();
    expect(releaseSecond).not.toHaveBeenCalled();
    registry.untrack('root');
    expect(releaseSecond).toHaveBeenCalledOnce();
  });

  it('drops every activation observer when the registry disposes', () => {
    const { registry, onRelease, scope, rootRun } = openRootScope();

    registry.dispose();

    // No observer may survive registry disposal. One that did would still see
    // this dispatch, claim a pending activation on the root stream it owns,
    // and hold the scope open past its own finish.
    registry.interactionOwnership.observeChildActivation(
      {
        runId: 'post-disposal-child',
        parentRunId: rootRun,
        childRunId: 'post-disposal-child-stream' as RunId,
        interrupt: vi.fn(),
        detach: vi.fn(),
        isDetached: () => false,
      },
      true,
    );
    scope.finish();

    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('stops observing the registry after an explicit release', () => {
    const { registry, onRelease, scope, rootRun } = openRootScope();

    scope.release();
    scope.release();

    expect(onRelease).toHaveBeenCalledOnce();

    // A late registration event must not revive a released generation.
    trackRun(registry, 'root', rootRun, rootRun);
    registry.untrack('root');
    scope.finish();
    expect(onRelease).toHaveBeenCalledOnce();
  });
});
