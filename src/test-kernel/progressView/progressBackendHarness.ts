// Shared fixtures for the ProgressBackend suites, which are split by concern
// (presentation, stream lifecycle, fact projection, durable cleanup, retained
// children) but build the same backend and emit through the same session
// channels.

// Third-party imports
import { afterEach } from 'vitest';

// Local imports
import { getExecutionStore } from '@agent/storage';
import type { AgentEvent } from '@agent/trace';
import type {
  DeleteExecutionOptions,
  DeleteExecutionResult,
} from '@agent/storage/executionListing';
import type { AgentConfig } from '@agent/core/definition/AgentConfig';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  ProgressBackend,
  type ProgressBackendOptions,
} from '@controllers/progressView/backend/ProgressBackend';
import {
  AgentCategory,
  type ExecutionId,
  type ProgressViewOutboundMessage,
  type SetActiveStreamPayload,
  type StreamTabId,
  type UpdateStreamDescriptionPayload,
} from '@shared/schemas';
import { FakeStateStore } from '@test/support/FakePlatform';
import {
  createApprovalOptions,
  createLifecycleOptions,
} from '@test/support/ProgressControllerHarnesses';
import { createTestSession } from '@test/support/sessionTestUtils';
import { StreamLogStore } from '@transcript';

/**
 * Everything a test creates that needs releasing. One owner tears them down in
 * reverse creation order, so no test carries its own `finally` teardown.
 */
const testDisposables: { dispose(): void }[] = [];

afterEach(() => {
  for (const disposable of testDisposables.splice(0).reverse()) {
    disposable.dispose();
  }
});

export function track<T extends { dispose(): void }>(disposable: T): T {
  testDisposables.push(disposable);
  return disposable;
}

/** A live-store session with restart repair deferred, as the hosts open it. */
export async function createLiveStoreSession(): Promise<SessionHandle> {
  return new SessionHandle({
    transcripts: await StreamLogStore.open(),
    restartRepair: 'deferred',
  });
}

export function toolUseConfig(agent: string, model: string): AgentConfig {
  return {
    agent,
    model,
    agentCategory: AgentCategory.ToolUse,
  } as AgentConfig;
}

export function createRecordingBackend(): {
  backend: ProgressBackend;
  messages: ProgressViewOutboundMessage[];
} {
  const messages: ProgressViewOutboundMessage[] = [];
  const backend = track(
    new ProgressBackend({
      storage: new FakeStateStore(),
      sendMessage: (message) => {
        messages.push(message);
        return true;
      },
      hasTarget: () => true,
      approvals: createApprovalOptions(),
      lifecycle: createLifecycleOptions(),
    }),
  );
  return { backend, messages };
}

export function createIsolatedRecordingBackend(
  session: SessionHandle = createTestSession(),
  lifecycle = createLifecycleOptions(),
): {
  backend: ProgressBackend;
  messages: ProgressViewOutboundMessage[];
  session: SessionHandle;
  lifecycle: ProgressBackendOptions['lifecycle'];
} {
  const messages: ProgressViewOutboundMessage[] = [];
  track(session);
  const backend = track(
    new ProgressBackend({
      storage: new FakeStateStore(),
      session,
      sendMessage: (message) => {
        messages.push(message);
        return true;
      },
      hasTarget: () => true,
      approvals: createApprovalOptions(),
      lifecycle,
    }),
  );
  return { backend, lifecycle, messages, session };
}

export async function createPersistentRecordingBackend(): Promise<
  ReturnType<typeof createIsolatedRecordingBackend>
> {
  return createIsolatedRecordingBackend(
    createTestSession({ transcripts: await StreamLogStore.open() }),
  );
}

interface ExecutionDeleter {
  deleteExecution(
    executionId: ExecutionId,
    options?: DeleteExecutionOptions,
  ): Promise<DeleteExecutionResult>;
}

/** `SessionStores.deleteExecution` is private; tests spy on it directly. */
export function executionDeleter(backend: ProgressBackend): ExecutionDeleter {
  return backend.state.stores as unknown as ExecutionDeleter;
}

export async function writeExecutionConfig(
  executionId: ExecutionId,
): Promise<void> {
  await getExecutionStore(executionId).writeRunRecord(
    toolUseConfig('search', 'deepseekproT'),
  );
}

export function emitRunEvent(
  target: { session: SessionHandle },
  streamId: StreamTabId,
  event: AgentEvent,
): void {
  target.session.events.emit({ scope: 'run', streamId, event });
}

export function emitActiveStream(
  target: { session: SessionHandle },
  payload: SetActiveStreamPayload,
): void {
  target.session.events.emit({
    scope: 'session',
    event: {
      type: 'setActiveStream',
      payload,
    },
  });
}

export function emitRunConfig(
  target: { session: SessionHandle },
  streamId: StreamTabId,
  executionId: ExecutionId,
  config: AgentConfig,
): void {
  emitRunEvent(target, streamId, {
    type: 'run.config',
    streamId,
    executionId,
    config,
  });
}

export function emitStreamDescription(
  target: { session: SessionHandle },
  payload: UpdateStreamDescriptionPayload,
): void {
  target.session.events.emit({
    scope: 'session',
    event: {
      type: 'updateStreamDescription',
      payload,
    },
  });
}
