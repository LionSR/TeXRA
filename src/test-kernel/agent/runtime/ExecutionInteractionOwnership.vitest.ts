// Interaction-ownership index (D3/T5): which host-interaction generation owns
// each live execution. Pins the release rule a host depends on — surfaces stay
// attached while any inheriting run is alive, and one generation never inherits
// another's runs. Design note: docs/design/execution-interaction-ownership.md.

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import type { StreamTabId } from '@shared/schemas';
import {
  testExecutionHandle,
  testExecutionRegistry,
} from '@test/support/executionHandleFixtures';

const liveRegistries: ExecutionRegistry[] = [];

afterEach(() => {
  for (const registry of liveRegistries.splice(0)) {
    registry.dispose();
  }
});

function createRegistry(): ExecutionRegistry {
  const registry = testExecutionRegistry();
  liveRegistries.push(registry);
  return registry;
}

function trackRun(
  registry: ExecutionRegistry,
  executionId: string,
  parentStreamId: StreamTabId,
  childStreamId: StreamTabId,
): void {
  registry.track(
    testExecutionHandle({
      executionId,
      parentStreamId,
      childStreamId,
      agent: 'test-agent',
    }),
  );
}

describe('execution interaction ownership', () => {
  it('releases only once the owner finished and its last run was untracked', () => {
    const registry = createRegistry();
    const onRelease = vi.fn();
    const scope = registry.interactionOwnership.open(onRelease);

    scope.claim('root');
    trackRun(
      registry,
      'root',
      'root-stream' as StreamTabId,
      'root-stream' as StreamTabId,
    );
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
    const registry = createRegistry();
    const onRelease = vi.fn();
    const scope = registry.interactionOwnership.open(onRelease);
    const rootStream = 'root-stream' as StreamTabId;

    scope.claim('root');
    trackRun(registry, 'root', rootStream, rootStream);
    // The child is never claimed by the host: it inherits through the stream
    // lineage of the root the host did claim.
    trackRun(registry, 'child', rootStream, 'child-stream' as StreamTabId);
    expect(registry.interactionOwnership.ownerOf('child')).toBe(scope);

    registry.untrack('root');
    scope.finish();
    expect(onRelease).not.toHaveBeenCalled();

    registry.untrack('child');
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('inherits a grandchild through the child stream it already owns', () => {
    const registry = createRegistry();
    const scope = registry.interactionOwnership.open(vi.fn());
    const rootStream = 'root-stream' as StreamTabId;
    const childStream = 'child-stream' as StreamTabId;

    scope.claim('root');
    trackRun(registry, 'root', rootStream, rootStream);
    trackRun(registry, 'child', rootStream, childStream);
    trackRun(
      registry,
      'grandchild',
      childStream,
      'grandchild-stream' as StreamTabId,
    );

    expect(registry.interactionOwnership.ownerOf('grandchild')).toBe(scope);
  });

  it('holds the owner across the gap between a child activation and its handle', () => {
    const registry = createRegistry();
    const onRelease = vi.fn();
    const scope = registry.interactionOwnership.open(onRelease);
    const rootStream = 'root-stream' as StreamTabId;
    const childStream = 'child-stream' as StreamTabId;

    scope.claim('root');
    trackRun(registry, 'root', rootStream, rootStream);
    registry.reserveChildActivation({
      executionId: 'child',
      parentStreamId: rootStream,
      childStreamId: childStream,
    });
    registry.untrack('root');
    scope.finish();
    expect(onRelease).not.toHaveBeenCalled();

    // Tracking the child's first handle promotes the reservation; the run it
    // promoted into is what now holds the owner open.
    trackRun(registry, 'child', rootStream, childStream);
    expect(onRelease).not.toHaveBeenCalled();

    registry.untrack('child');
    expect(onRelease).toHaveBeenCalledOnce();
  });

  it('releases the owner when a reserved child activation fails to start', () => {
    const registry = createRegistry();
    const onRelease = vi.fn();
    const scope = registry.interactionOwnership.open(onRelease);
    const rootStream = 'root-stream' as StreamTabId;
    const childStream = 'child-stream' as StreamTabId;

    scope.claim('root');
    trackRun(registry, 'root', rootStream, rootStream);
    const releaseActivation = registry.reserveChildActivation({
      executionId: 'child',
      parentStreamId: rootStream,
      childStreamId: childStream,
    });
    registry.untrack('root');
    scope.finish();
    expect(onRelease).not.toHaveBeenCalled();

    releaseActivation();
    expect(onRelease).toHaveBeenCalledOnce();
    expect(registry.interactionOwnership.ownerOf('child')).toBeUndefined();
  });

  it('does not let a later generation inherit or release an earlier one', () => {
    const registry = createRegistry();
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    const first = registry.interactionOwnership.open(releaseFirst);
    const firstRootStream = 'first-root' as StreamTabId;

    first.claim('first-root');
    trackRun(registry, 'first-root', firstRootStream, firstRootStream);
    trackRun(
      registry,
      'first-child',
      firstRootStream,
      'first-child-stream' as StreamTabId,
    );
    registry.untrack('first-root');
    first.finish();

    const second = registry.interactionOwnership.open(releaseSecond);
    const secondRootStream = 'second-root' as StreamTabId;
    second.claim('second-root');
    trackRun(registry, 'second-root', secondRootStream, secondRootStream);
    registry.untrack('second-root');
    second.finish();

    expect(releaseSecond).toHaveBeenCalledOnce();
    expect(releaseFirst).not.toHaveBeenCalled();
    // The second generation's release must not strip the first's claims.
    expect(registry.interactionOwnership.ownerOf('first-child')).toBe(first);

    registry.untrack('first-child');
    expect(releaseFirst).toHaveBeenCalledOnce();
  });

  it('drops a run whose replacement handle another generation claimed', () => {
    const registry = createRegistry();
    const releaseFirst = vi.fn();
    const releaseSecond = vi.fn();
    const first = registry.interactionOwnership.open(releaseFirst);
    const second = registry.interactionOwnership.open(releaseSecond);
    const rootStream = 'root-stream' as StreamTabId;

    first.claim('root');
    trackRun(registry, 'root', rootStream, rootStream);
    // A resume in a later generation claims the same execution id, then
    // registers its own handle for it.
    second.claim('root');
    trackRun(registry, 'root', rootStream, rootStream);

    first.finish();
    expect(releaseFirst).toHaveBeenCalledOnce();
    expect(releaseSecond).not.toHaveBeenCalled();

    second.finish();
    expect(releaseSecond).not.toHaveBeenCalled();
    registry.untrack('root');
    expect(releaseSecond).toHaveBeenCalledOnce();
  });

  it('stops observing the registry after an explicit release', () => {
    const registry = createRegistry();
    const onRelease = vi.fn();
    const scope = registry.interactionOwnership.open(onRelease);
    const rootStream = 'root-stream' as StreamTabId;

    scope.claim('root');
    trackRun(registry, 'root', rootStream, rootStream);
    scope.release();
    scope.release();

    expect(onRelease).toHaveBeenCalledOnce();
    expect(registry.interactionOwnership.ownerOf('root')).toBeUndefined();

    // A late registration event must not revive a released generation.
    trackRun(registry, 'root', rootStream, rootStream);
    registry.untrack('root');
    scope.finish();
    expect(onRelease).toHaveBeenCalledOnce();
    expect(registry.interactionOwnership.ownerOf('root')).toBeUndefined();
  });
});
