// Third-party imports
import { describe, expect, it, vi } from 'vitest';

// Local imports
import { AgentExecutionHandle } from '@agent/runtime/ExecutionHandle';
import { ExecutionRegistry } from '@agent/runtime/executionRegistry';
import { ExecutionSubscriptionBinder } from '@agent/runtime/ExecutionSubscriptionBinder';
import type { StreamTabId } from '@shared/schemas';

import { createRecordingHost } from '../progressTestUtils';

const streamId = 'stream:execution-subscription-test' as StreamTabId;
const childStreamId = 'child:execution-subscription-test' as StreamTabId;

function createReleaseSource() {
  let observer: ((streamId: StreamTabId) => void) | undefined;
  return {
    source: {
      onRelease(nextObserver: (streamId: StreamTabId) => void): () => void {
        observer = nextObserver;
        return () => {
          if (observer === nextObserver) observer = undefined;
        };
      },
    },
    release(stream: StreamTabId): void {
      observer?.(stream);
    },
    hasObserver(): boolean {
      return observer !== undefined;
    },
  };
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
  };
}

function setupBinder(executionId: string) {
  const registry = new ExecutionRegistry();
  const releaseSource = createReleaseSource();
  const logger = createLogger();
  const explicit = createRecordingHost();
  const binder = new ExecutionSubscriptionBinder({
    registry,
    releaseSource: releaseSource.source,
    logger,
  });
  const handle = new AgentExecutionHandle(
    executionId,
    streamId,
    childStreamId,
    'search',
    'toolUse',
    explicit.host,
  );
  registry.track(handle);
  return { registry, releaseSource, logger, explicit, binder, executionId };
}

describe('ExecutionSubscriptionBinder', () => {
  it('owns bind and unbind state per stream/execution pair', () => {
    const { registry, logger, explicit, binder, executionId } = setupBinder(
      'exec-subscription-bind-test',
    );

    try {
      binder.bind(streamId, executionId, explicit.host);
      binder.bind(streamId, executionId, explicit.host);

      expect(binder.unbind(streamId, executionId)).toBe(true);
      expect(binder.unbind(streamId, executionId)).toBe(false);
      expect(logger.info).toHaveBeenCalledTimes(1);
    } finally {
      binder.dispose();
      registry.dispose();
    }
  });

  it('disposes stream subscriptions when the follow-up queue is released', () => {
    const { registry, releaseSource, explicit, binder, executionId } =
      setupBinder('exec-subscription-release-test');

    try {
      binder.bind(streamId, executionId, explicit.host);

      releaseSource.release(streamId);

      expect(binder.unbind(streamId, executionId)).toBe(false);
    } finally {
      binder.dispose();
      registry.dispose();
    }
  });

  it('unregisters the release observer when disposed', () => {
    const { registry, releaseSource, explicit, binder, executionId } =
      setupBinder('exec-subscription-dispose-test');

    try {
      binder.bind(streamId, executionId, explicit.host);

      expect(releaseSource.hasObserver()).toBe(true);
      binder.dispose();

      expect(releaseSource.hasObserver()).toBe(false);
      expect(binder.unbind(streamId, executionId)).toBe(false);
    } finally {
      registry.dispose();
    }
  });
});
