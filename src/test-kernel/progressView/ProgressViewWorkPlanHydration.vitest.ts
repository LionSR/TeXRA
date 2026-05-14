// Third-party imports
import { describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => ({
  default: {},
  Disposable: class {
    constructor(private readonly callback: () => void) {}

    dispose(): void {
      this.callback();
    }
  },
  window: {},
  workspace: {},
  Uri: {},
}));

// Local imports
import { ProgressEventHandler } from '@progressView/events/ProgressEventHandler';
import type { WebviewBridge } from '@progressView/managers/WebviewBridge';
import type {
  SyncStreamContentPayload,
  WebviewUpdater,
} from '@progressView/managers/WebviewUpdater';
import type { MementoStorage } from '@progressView/persistence/PersistentMapManager';
import { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { Plan, TodoItem } from '@shared/schemas';

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

const todo: TodoItem = {
  content: 'Hydrate work-plan state',
  status: 'pending',
  activeForm: 'Hydrating work-plan state',
};

const plan: Plan = {
  summary: 'Hydrate plan and todo state from one backend owner.',
  steps: [
    {
      title: 'Sync active stream',
      description: 'Read todos and plan from ProgressViewState.workPlan.',
      status: 'pending',
      files: [
        'packages/extension/src/progressView/events/ProgressEventHandler.ts',
      ],
    },
  ],
};

describe('progress view work-plan hydration', () => {
  it('syncs todos and plan from the current package progress-view state', async () => {
    const state = new ProgressViewState(new MemoryMementoStorage());
    await Promise.all([
      state.outputFiles.load([]),
      state.usageStats.load([]),
      state.meta.load([]),
    ]);
    const messages: SyncStreamContentPayload[] = [];
    const updater = {
      isAvailable: () => true,
      sendSyncStreamContent: (payload: SyncStreamContentPayload) => {
        messages.push(payload);
      },
    } as unknown as WebviewUpdater;
    const bridge = {
      syncStream: vi.fn(),
      clearAll: vi.fn(),
    } as unknown as WebviewBridge;
    const handler = new ProgressEventHandler(
      state,
      updater,
      bridge,
      {} as never,
      () => false,
    );

    state.setTodos('stream:work-plan', [todo]);
    state.setPlan('stream:work-plan', plan);
    handler.syncStreamContent('stream:work-plan');

    expect(bridge.syncStream).toHaveBeenCalledWith('stream:work-plan');
    expect(messages.at(-1)).toMatchObject({
      stream: 'stream:work-plan',
      action: 'render',
      todos: [todo],
      plan,
    });
    expect(state.getWorkPlan('stream:work-plan')).toEqual({
      todos: [todo],
      plan,
      planSummary: plan.summary,
    });
  });
});
