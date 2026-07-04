import { describe, expect, it, vi } from 'vitest';

import { TraceEmitter } from '@agent/trace';
import { SessionEventHub } from '@agent/runtime/SessionEventHub';
import { attachSessionRunFactProjector } from '@agent/runtime/SessionRunFactProjector';
import { emitRunFact } from '@agent/runtime/runFactEvents';
import type {
  ProgressEvent,
  ProgressEventBusLike,
  ProgressEventPayloads,
} from '@eventBus/ProgressEventBus';
import {
  AgentCategory,
  type CompileFailure,
  type FileLocation,
  type OutputFileInfo,
  type Plan,
  type StorageKey,
  type StreamTabId,
  type SyncStreamContentPayload,
  type TodoItem,
} from '@shared/schemas';
import {
  ProgressEventHandler,
  type UICallbacks,
} from '@shared/progressView/backend/events/ProgressEventHandler';
import type { MementoStorage } from '@shared/progressView/backend/persistence/PersistentMapManager';
import { ProgressViewState } from '@shared/progressView/backend/state/ProgressViewState';
import type { WebviewBridge } from '@shared/progressView/backend/WebviewBridge';
import type { WebviewUpdater } from '@shared/progressView/backend/WebviewUpdater';

class MemoryMementoStorage implements MementoStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? (this.values.get(key) as T) : defaultValue;
  }

  update<T>(key: string, value: T): Thenable<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

class MemoryProgressBus implements ProgressEventBusLike {
  private readonly listeners = new Map<
    ProgressEvent,
    Set<(payload: ProgressEventPayloads[ProgressEvent]) => void>
  >();

  on<K extends ProgressEvent>(
    event: K,
    listener: (payload: ProgressEventPayloads[K]) => void,
    options?: { signal?: AbortSignal },
  ): () => void {
    if (options?.signal?.aborted) return () => {};
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(
      listener as (payload: ProgressEventPayloads[ProgressEvent]) => void,
    );
    this.listeners.set(event, listeners);
    const cleanup = () => {
      listeners.delete(
        listener as (payload: ProgressEventPayloads[ProgressEvent]) => void,
      );
    };
    options?.signal?.addEventListener('abort', cleanup, { once: true });
    return cleanup;
  }

  emit<K extends ProgressEvent>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(payload);
    }
  }
}

const streamId = 'stream:projector-equivalence' as StreamTabId;
const usageStorageKey = 'run:usage' as StorageKey;
const todos: TodoItem[] = [
  {
    content: 'Keep projector output identical',
    status: 'pending',
    activeForm: 'Keeping projector output identical',
  },
];
const plan: Plan = { objective: 'Project easy run facts through the hub.' };

function workspaceFile(relativePath: string): FileLocation {
  return {
    kind: 'workspace',
    absolutePath: `/workspace/${relativePath}`,
    relativePath,
  };
}

const outputFile: OutputFileInfo = {
  source: 'paper.tex',
  location: workspaceFile('paper.tex'),
  round: 1,
  lineage: null,
  diff: null,
};

const compileFailure: CompileFailure = {
  round: 1,
  displayName: 'paper.tex',
  output: workspaceFile('paper.pdf'),
  log: workspaceFile('paper.log'),
  logRelativePath: 'paper.log',
};

interface Harness {
  bus: MemoryProgressBus;
  handler: ProgressEventHandler;
  messages: SyncStreamContentPayload[];
}

async function createHarness(): Promise<Harness> {
  const state = new ProgressViewState(new MemoryMementoStorage());
  await state.snapshots.load([]);
  state.activeStream = streamId;
  state.streamLogs.ensureStream(streamId);
  state.updateStreamHints(streamId, { agentCategory: AgentCategory.Workflow });
  state.getOrCreateStreamState(streamId, AgentCategory.Workflow);

  const messages: SyncStreamContentPayload[] = [];
  const updater = {
    isAvailable: () => true,
    updateFiles: vi.fn(),
    updateMissingOutputs: vi.fn(),
    updateCompileFailures: vi.fn(),
    updateRunUsage: vi.fn(),
    updateTodos: vi.fn(),
    updatePlan: vi.fn(),
    sendSyncStreamContent: (payload: SyncStreamContentPayload) => {
      messages.push(payload);
    },
  } as unknown as WebviewUpdater;
  const bridge = {
    syncStream: vi.fn(),
    clearAll: vi.fn(),
  } as unknown as WebviewBridge;
  const bus = new MemoryProgressBus();
  const handler = new ProgressEventHandler(
    state,
    updater,
    bridge,
    {} as UICallbacks,
    () => false,
  );
  handler.setupEventListeners(bus);
  return { bus, handler, messages };
}

function emitDirectFacts(bus: ProgressEventBusLike): void {
  bus.emit('updateTodos', { streamId, todos });
  bus.emit('updatePlan', { streamId, plan });
  bus.emit('addOutputFiles', { streamId, filesByRound: { 1: [outputFile] } });
  bus.emit('updateMissingOutputs', {
    streamId,
    filesByRound: { 1: ['paper.pdf'] },
  });
  bus.emit('updateCompileFailures', {
    streamId,
    filesByRound: { 1: [compileFailure] },
  });
  bus.emit('updateStreamUsage', {
    streamId,
    storageKey: usageStorageKey,
    usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
  });
}

function emitHubFacts(trace: TraceEmitter): void {
  emitRunFact(trace, 'updateTodos', { streamId, todos });
  emitRunFact(trace, 'updatePlan', { streamId, plan });
  emitRunFact(trace, 'addOutputFiles', {
    streamId,
    filesByRound: { 1: [outputFile] },
  });
  emitRunFact(trace, 'updateMissingOutputs', {
    streamId,
    filesByRound: { 1: ['paper.pdf'] },
  });
  emitRunFact(trace, 'updateCompileFailures', {
    streamId,
    filesByRound: { 1: [compileFailure] },
  });
  trace.usage(
    { inputTokens: 10, outputTokens: 5, cost: 0.01 },
    {
      data: {
        streamId,
        storageKey: usageStorageKey,
        usage: { inputTokens: 10, outputTokens: 5, cost: 0.01 },
      },
      recordTranscript: false,
    },
  );
}

async function settleUsageProjection(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('SessionRunFactProjector', () => {
  it('produces the same progress backend state as direct bus events', async () => {
    const direct = await createHarness();
    emitDirectFacts(direct.bus);
    await settleUsageProjection();
    direct.handler.syncStreamContent(streamId);

    const hubFed = await createHarness();
    const hub = new SessionEventHub();
    const trace = new TraceEmitter();
    const detachTrace = trace.subscribe((event) =>
      hub.emit({ scope: 'run', streamId, event }),
    );
    const detachProjector = attachSessionRunFactProjector(
      hub,
      {
        emit: (event, payload) => hubFed.bus.emit(event, payload),
      },
      streamId,
    );
    emitHubFacts(trace);
    await settleUsageProjection();
    hubFed.handler.syncStreamContent(streamId);

    expect(hubFed.messages.at(-1)).toEqual(direct.messages.at(-1));

    detachProjector();
    detachTrace();
  });
});
