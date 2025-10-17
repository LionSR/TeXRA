// Standard library imports
import { strict as assert } from 'assert';

// Local imports - progress view
import { createStreamStatusEvents } from '@progressView/events/StreamStatusEvents';
import { createOutputEvents } from '@progressView/events/OutputEvents';
import { createUsageEvents } from '@progressView/events/UsageEvents';
import { createLogEvents } from '@progressView/events/LogEvents';
import { createTaskGroupEvents } from '@progressView/events/TaskGroupEvents';

import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { AgentLogger } from '@logger/AgentLogger';

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
      updateLogContentForStream: () => {},
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
    });

    const calls: string[] = [];
    const state = {
      outputFiles: {
        addFiles: () => {},
        getFiles: () => undefined,
        updateMissingOutputs: () => {},
        getMissingOutputs: () => undefined,
        clearMissingOutputs: () => {},
        clearFiles: () => {},
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
      initializeStreamForTaskGroup: () => {},
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
      initializeStreamForTaskGroup: (stream) => {
        initialized.push(stream);
      },
    });

    const state = {
      streamTabs: {
        has: () => false,
        ensureStream: () => {},
        addMessage: () => {},
        get: () => undefined,
        save: () => {},
      },
      taskGroups: {
        addGroup: () => {},
        updateGroup: () => {},
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
});
