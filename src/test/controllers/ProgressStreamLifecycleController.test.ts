// Standard library imports
import { strict as assert } from 'assert';

// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

// Local imports - controllers
import {
  ProgressStreamLifecycleController,
  type ProgressStreamLifecycleState,
} from '../../controllers/progressView/ProgressStreamLifecycleController';

function createController(options?: {
  streams?: StreamTabId[];
  activeStream?: StreamTabId | '';
  taskStateStreams?: StreamTabId[];
  inFlightStreams?: StreamTabId[];
  visibleStreams?: StreamTabId[];
}): {
  controller: ProgressStreamLifecycleController;
  calls: Map<string, StreamTabId[]>;
  syncCalls: Array<{ forceRebuild: boolean }>;
  state: ProgressStreamLifecycleState;
  activeStream: () => StreamTabId | '';
  streams: () => StreamTabId[];
} {
  let streams = [...(options?.streams ?? ['stream-a', 'stream-b'])];
  let activeStream = options?.activeStream ?? streams[0] ?? '';
  const taskStateStreams = new Set(options?.taskStateStreams ?? []);
  const inFlightStreams = new Set(options?.inFlightStreams ?? []);
  const calls = new Map<string, StreamTabId[]>();
  const syncCalls: Array<{ forceRebuild: boolean }> = [];
  const record = (name: string, stream: StreamTabId) => {
    calls.set(name, [...(calls.get(name) ?? []), stream]);
  };
  const state: ProgressStreamLifecycleState = {
    getActiveStream: () => activeStream,
    setActiveStream: (stream) => {
      activeStream = stream;
    },
    hasStream: (stream) => streams.includes(stream),
    hasTaskState: (stream) => taskStateStreams.has(stream),
    getStreamIds: () => streams,
    pickValidActiveStream: (availableStreams) => availableStreams[0] ?? '',
    clearStream: async (stream) => {
      streams = streams.filter((candidate) => candidate !== stream);
    },
    clearAll: async () => {
      streams = [];
      activeStream = '';
    },
  };

  return {
    controller: new ProgressStreamLifecycleController({
      state,
      isStreamInFlight: (stream) => inFlightStreams.has(stream),
      getVisibleStreamIds: () =>
        options?.visibleStreams ??
        streams.filter((stream) => stream !== 'hidden'),
      stopStream: async (stream) => record('stop', stream),
      clearRetryRequest: (stream) => record('clearRetry', stream),
      releaseFollowUpQueue: (stream) => record('releaseFollowUp', stream),
      cleanupApprovalsForStream: (stream) => record('cleanupApprovals', stream),
      cleanupAllApprovals: () => record('cleanupAllApprovals', 'all'),
      clearModelOutputBackups: (stream) =>
        record('clearBackups', stream ?? 'all'),
      clearWebviewStream: (stream) => record('clearWebview', stream),
      clearAllWebviewStreams: () => record('clearAllWebview', 'all'),
      deleteWebviewStream: (stream) => record('deleteWebview', stream),
      syncFullView: (options) => syncCalls.push(options),
      setActiveStream: async (stream) => record('setActiveStream', stream),
    }),
    calls,
    syncCalls,
    state,
    activeStream: () => activeStream,
    streams: () => streams,
  };
}

describe('ProgressStreamLifecycleController', () => {
  it('ignores deletion for unknown streams', async () => {
    const { controller, calls, streams } = createController();

    await controller.deleteStream('missing');

    assert.deepEqual(streams(), ['stream-a', 'stream-b']);
    assert.equal(calls.size, 0);
  });

  it('deletes inactive streams without stopping finished work', async () => {
    const { controller, calls, streams, activeStream } = createController({
      activeStream: 'stream-a',
    });

    await controller.deleteStream('stream-b');

    assert.deepEqual(streams(), ['stream-a']);
    assert.equal(activeStream(), 'stream-a');
    assert.deepEqual(calls.get('stop'), undefined);
    assert.deepEqual(calls.get('cleanupApprovals'), ['stream-b']);
    assert.deepEqual(calls.get('clearRetry'), ['stream-b']);
    assert.deepEqual(calls.get('releaseFollowUp'), ['stream-b']);
    assert.deepEqual(calls.get('clearBackups'), ['stream-b']);
    assert.deepEqual(calls.get('clearWebview'), ['stream-b']);
    assert.deepEqual(calls.get('deleteWebview'), ['stream-b']);
  });

  it('stops running streams and activates the next visible stream', async () => {
    const { controller, calls, streams, activeStream } = createController({
      activeStream: 'stream-a',
      inFlightStreams: ['stream-a'],
      visibleStreams: ['stream-b'],
    });

    await controller.deleteStream('stream-a');

    assert.deepEqual(streams(), ['stream-b']);
    assert.equal(activeStream(), 'stream-b');
    assert.deepEqual(calls.get('stop'), ['stream-a']);
    assert.deepEqual(calls.get('setActiveStream'), ['stream-b']);
  });

  it('clears all stream lifecycle state', async () => {
    const { controller, calls, streams, activeStream, syncCalls } =
      createController();

    await controller.deleteAllStreams();

    assert.deepEqual(streams(), []);
    assert.equal(activeStream(), '');
    assert.deepEqual(calls.get('stop'), ['stream-a', 'stream-b']);
    assert.deepEqual(calls.get('cleanupAllApprovals'), ['all']);
    assert.deepEqual(calls.get('clearRetry'), ['stream-a', 'stream-b']);
    assert.deepEqual(calls.get('releaseFollowUp'), ['stream-a', 'stream-b']);
    assert.deepEqual(calls.get('clearBackups'), ['all']);
    assert.deepEqual(calls.get('clearAllWebview'), ['all']);
    assert.deepEqual(syncCalls, [{ forceRebuild: true }]);
  });
});
