// Standard library imports
import { strict as assert } from 'assert';

// Local imports - progress view
import type { AgentLogger } from '@logger/AgentLogger';
import type { WebviewUpdater } from '@progressView/managers';

// Internal imports
import { createStreamStatusEvents } from '@progressView/events/StreamStatusEvents';
import { createOutputEvents } from '@progressView/events/OutputEvents';
import { createUsageEvents } from '@progressView/events/UsageEvents';
import { createLogEvents } from '@progressView/events/LogEvents';
import { createTaskGroupEvents } from '@progressView/events/TaskGroupEvents';
// Type imports
import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import { ProgressEventHandler } from '@progressView/events/ProgressEventHandler';

// Event bus imports
import { bus, type ProgressEventPayloads } from '@eventBus/ProgressEventBus';

class FakeBus {
  public readonly events: (keyof ProgressEventPayloads)[] = [];
  public readonly disposed: (keyof ProgressEventPayloads)[] = [];
  public readonly listeners = new Map<
    keyof ProgressEventPayloads,
    (payload: ProgressEventPayloads[keyof ProgressEventPayloads]) => void
  >();
  public readonly emissions: {
    event: keyof ProgressEventPayloads;
    payload: ProgressEventPayloads[keyof ProgressEventPayloads];
  }[] = [];

  on<K extends keyof ProgressEventPayloads>(
    event: K,
    _listener: (payload: ProgressEventPayloads[K]) => void,
  ): () => void {
    this.events.push(event);
    this.listeners.set(event, _listener as any);
    return () => {
      this.disposed.push(event);
      this.listeners.delete(event);
    };
  }

  emit<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    this.emissions.push({ event, payload });
  }

  trigger<K extends keyof ProgressEventPayloads>(
    event: K,
    payload: ProgressEventPayloads[K],
  ): void {
    const listener = this.listeners.get(event) as
      | ((value: ProgressEventPayloads[K]) => void)
      | undefined;
    listener?.(payload);
  }
}

describe('Progress event modules', () => {
  const loggerStub = {
    warn: () => {},
    debug: () => {},
    error: () => {},
  } as unknown as AgentLogger;
  const stateStub = {} as ProgressViewState;
  const updaterStub = {} as WebviewUpdater;

  it('registers stream status handlers and disposes them', () => {
    const bus = new FakeBus();
    const module = createStreamStatusEvents({
      logger: loggerStub,
      streamStatus: new Map(),
      setStreamStatus: () => {},
      sendInstructionUpdate: () => {},
      refreshStreamSurface: () => {},
    });

    const disposables = module.register(bus as any, stateStub, updaterStub);
    assert.deepStrictEqual(bus.events, [
      'setActiveStream',
      'updateStreamStatus',
      'setTaskState',
    ]);

    disposables.forEach((disposable) => disposable.dispose());
    assert.deepStrictEqual(bus.disposed, bus.events);
  });

  it('registers output handlers and disposes them', () => {
    const bus = new FakeBus();
    const module = createOutputEvents({
      logger: loggerStub,
      refreshStreamSurface: () => {},
      getAllStreamStatuses: () => new Map(),
    });

    const disposables = module.register(bus as any, stateStub, updaterStub);
    assert.deepStrictEqual(bus.events, [
      'addOutputFiles',
      'updateMissingOutputs',
      'clearMissingOutputs',
      'clearOutputFiles',
      'clearTaskOutput',
    ]);

    disposables.forEach((disposable) => disposable.dispose());
    assert.deepStrictEqual(bus.disposed, bus.events);
  });

  it('delegates clearTaskOutput to ProgressViewState.clearOutputState', () => {
    const bus = new FakeBus();
    const module = createOutputEvents({
      logger: loggerStub,
      refreshStreamSurface: () => {},
      getAllStreamStatuses: () => new Map(),
    });

    const calls: string[] = [];
    const state = {
      outputFiles: {
        addFiles: async () => {},
        getFiles: () => undefined,
        updateMissingOutputs: async () => {},
        getMissingOutputs: () => undefined,
        clearMissingOutputs: async () => {},
        clearFiles: async () => {},
      },
      clearOutputState: (stream: string) => {
        calls.push(stream);
      },
      activeStream: '',
    } as unknown as ProgressViewState;
    const updater = {
      isAvailable: () => false,
      updateFiles: () => {},
      updateMissingOutputs: () => {},
    } as unknown as WebviewUpdater;

    module.register(bus as any, state, updater);
    bus.trigger('clearTaskOutput', 'stream-42');

    assert.deepStrictEqual(calls, ['stream-42']);
  });

  it('registers usage handlers and disposes them', () => {
    const bus = new FakeBus();
    const module = createUsageEvents({
      logger: loggerStub,
    });

    const disposables = module.register(bus as any, stateStub, updaterStub);
    assert.deepStrictEqual(bus.events, [
      'updateGroupUsage',
      'updateStreamUsage',
    ]);

    disposables.forEach((disposable) => disposable.dispose());
    assert.deepStrictEqual(bus.disposed, bus.events);
  });

  it('registers log handlers and disposes them', () => {
    const bus = new FakeBus();
    const module = createLogEvents({
      logger: loggerStub,
    });

    const disposables = module.register(bus as any, stateStub, updaterStub);
    assert.deepStrictEqual(bus.events, ['addLogMessage', 'updateLogMessage']);

    disposables.forEach((disposable) => disposable.dispose());
    assert.deepStrictEqual(bus.disposed, bus.events);
  });

  it('registers task group handlers and disposes them', () => {
    const bus = new FakeBus();
    const module = createTaskGroupEvents({
      logger: loggerStub,
      initializeStreamForTaskGroup: async () => {},
    });

    const disposables = module.register(bus as any, stateStub, updaterStub);
    assert.deepStrictEqual(bus.events, ['addTaskGroup', 'updateTaskGroup']);

    disposables.forEach((disposable) => disposable.dispose());
    assert.deepStrictEqual(bus.disposed, bus.events);
  });

  it('initializes new streams via the provided initializer', () => {
    const bus = new FakeBus();
    const initialized: string[] = [];
    const module = createTaskGroupEvents({
      logger: loggerStub,
      initializeStreamForTaskGroup: async (stream) => {
        initialized.push(stream);
      },
    });

    const state = {
      streamTabs: {
        has: () => false,
        ensureStream: async () => {},
        addMessage: async () => {},
        get: () => undefined,
        save: async () => {},
      },
      taskGroups: {
        addGroup: async () => {},
        updateGroup: async () => {},
      },
      setSessionKindHint: () => {},
      agentTypeFilter: 'all',
      activeStream: '',
    } as unknown as ProgressViewState;
    const updater = {
      isAvailable: () => false,
      addTaskGroup: () => {},
    } as unknown as WebviewUpdater;

    module.register(bus as any, state, updater);

    bus.trigger('addTaskGroup', {
      stream: 'stream-1',
      groupId: 'group-1',
      groupName: 'Group',
      startTime: 0,
      status: 'running',
    });

    assert.deepStrictEqual(initialized, ['stream-1']);
    assert.deepStrictEqual(bus.emissions, []);
  });

  it('registers task groups before log handlers to avoid thinking replay races', () => {
    const state = {
      streamTabs: {
        ensureStream: async () => {},
        has: () => true,
        addMessage: async () => {},
        getMessages: () => [],
        save: async () => {},
      },
      taskGroups: {
        addGroup: async () => {},
        updateGroup: async () => {},
        getStreamGroups: () => new Map(),
      },
      outputFiles: {
        addFiles: async () => {},
        updateMissingOutputs: async () => {},
        clearMissingOutputs: async () => {},
        clearFiles: async () => {},
        getFiles: () => new Map(),
        getMissingOutputs: () => new Map(),
      },
      usageStats: {
        getRunUsage: () => new Map(),
        setRunUsage: () => {},
      },
      runInstructions: {
        getInstructions: () => new Map(),
        setInstruction: async () => {},
        deleteRun: async () => {},
      },
      agentTypeFilter: 'all',
      setActiveRunId: () => {},
      resolveRunId: () => null,
      setSessionKindHint: () => {},
      clearSessionKindHint: () => {},
      clearRunInstructions: () => {},
      clearRunFiles: () => {},
      clearRunMissingOutputs: () => {},
      clearRunUsage: () => {},
      clearAllActiveRuns: () => {},
      clearAllPendingInstructions: () => {},
      getTaskState: () => undefined,
      activeStream: '',
    } as unknown as ProgressViewState;

    const updater = {
      isAvailable: () => false,
      updateLogContent: () => {},
      updateFiles: () => {},
      updateMissingOutputs: () => {},
      updateUsage: () => {},
      addTaskGroup: () => {},
      updateTaskGroup: () => {},
    } as unknown as WebviewUpdater;

    const registeredEvents: (keyof ProgressEventPayloads)[] = [];
    const originalOn = bus.on.bind(bus);

    const restoreBus = () => {
      (bus as unknown as { on: typeof bus.on }).on = originalOn;
    };

    (bus as unknown as { on: typeof bus.on }).on = ((event, listener) => {
      registeredEvents.push(event);
      return originalOn(event, listener);
    }) as typeof bus.on;

    const disposables: { dispose: () => void }[] = [];

    try {
      const handler = new ProgressEventHandler(state, updater);
      disposables.push(...handler.setupEventListeners());

      assert.deepStrictEqual(registeredEvents, [
        'setActiveStream',
        'updateStreamStatus',
        'setTaskState',
        'addOutputFiles',
        'updateMissingOutputs',
        'clearMissingOutputs',
        'clearOutputFiles',
        'clearTaskOutput',
        'updateGroupUsage',
        'updateStreamUsage',
        'addTaskGroup',
        'updateTaskGroup',
        'addLogMessage',
        'updateLogMessage',
      ]);
    } finally {
      disposables.forEach((disposable) => disposable.dispose());
      restoreBus();
    }
  });
});
