// Standard library imports
import { strict as assert } from 'assert';

// Local imports - progress view
import { createStreamStatusEvents } from '@progressView/events/StreamStatusEvents';
import { createOutputEvents } from '@progressView/events/OutputEvents';
import { createUsageEvents } from '@progressView/events/UsageEvents';
import { createLogEvents } from '@progressView/events/LogEvents';

import type { ProgressViewState } from '@progressView/state/ProgressViewState';
import type { WebviewUpdater } from '@progressView/managers';
import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type { AgentLogger } from '@logger/AgentLogger';

class FakeBus {
  public readonly events: (keyof ProgressEventPayloads)[] = [];
  public readonly disposed: (keyof ProgressEventPayloads)[] = [];

  on<K extends keyof ProgressEventPayloads>(
    event: K,
    _listener: (payload: ProgressEventPayloads[K]) => void,
  ): () => void {
    this.events.push(event);
    return () => {
      this.disposed.push(event);
    };
  }
}

describe('Progress event modules', () => {
  const loggerStub = {
    warn: () => {},
    debug: () => {},
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
    const module = createOutputEvents();

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

  it('registers usage handlers and disposes them', () => {
    const bus = new FakeBus();
    const module = createUsageEvents();

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
      streamStatus: new Map(),
      activateStream: () => {},
      setStreamStatus: () => {},
    });

    const disposables = module.register(bus as any, stateStub, updaterStub);
    assert.deepStrictEqual(bus.events, [
      'addLogMessage',
      'updateLogMessage',
      'addTaskGroup',
      'updateTaskGroup',
    ]);

    disposables.forEach((disposable) => disposable.dispose());
    assert.deepStrictEqual(bus.disposed, bus.events);
  });
});
