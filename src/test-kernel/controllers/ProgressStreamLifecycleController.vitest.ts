// Third-party imports
import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

// Local imports - shared
import type { StreamTabId } from '@shared/schemas';

// Local imports - test support
import { createProgressStreamLifecycleHarness } from '../support/ProgressControllerHarnesses';

describe('ProgressStreamLifecycleController', () => {
  it('runs durable cleanup for unknown streams without rendered cleanup', async () => {
    const { controller, recorder, streams } =
      createProgressStreamLifecycleHarness();

    await controller.deleteStream('missing');

    assert.deepEqual(streams(), ['stream-a', 'stream-b']);
    assert.deepEqual(recorder.calls.get('clearStream'), ['missing']);
    assert.deepEqual(recorder.calls.get('cleanupApprovals'), undefined);
    assert.deepEqual(recorder.calls.get('deleteWebview'), undefined);
    assert.deepEqual(recorder.calls.get('setActiveStream'), undefined);
  });

  it('refuses reserved unknown stream ids before durable cleanup', async () => {
    const { controller, recorder, streams } =
      createProgressStreamLifecycleHarness();

    await controller.deleteStream('' as StreamTabId);
    await controller.deleteStream('.' as StreamTabId);
    await controller.deleteStream('..' as StreamTabId);

    assert.deepEqual(streams(), ['stream-a', 'stream-b']);
    assert.deepEqual(recorder.calls.get('clearStream'), undefined);
  });

  it('refuses reserved known stream ids before rendered or durable cleanup', async () => {
    const reservedStreams = [
      '' as StreamTabId,
      '.' as StreamTabId,
      '..' as StreamTabId,
    ];
    const { controller, recorder, streams } =
      createProgressStreamLifecycleHarness({
        streams: [...reservedStreams, 'stream-a'],
        activeStream: 'stream-a',
      });

    for (const stream of reservedStreams) {
      await controller.deleteStream(stream);
    }

    assert.deepEqual(streams(), ['', '.', '..', 'stream-a']);
    assert.deepEqual(recorder.calls.get('clearStream'), undefined);
    assert.deepEqual(recorder.calls.get('cleanupApprovals'), undefined);
    assert.deepEqual(recorder.calls.get('deleteWebview'), undefined);
  });

  it('deletes inactive streams without stopping finished work', async () => {
    const { controller, recorder, streams, activeStream } =
      createProgressStreamLifecycleHarness({
        activeStream: 'stream-a',
      });

    await controller.deleteStream('stream-b');

    assert.deepEqual(streams(), ['stream-a']);
    assert.equal(activeStream(), 'stream-a');
    assert.deepEqual(recorder.calls.get('stop'), undefined);
    assert.deepEqual(recorder.calls.get('cleanupApprovals'), ['stream-b']);
    assert.deepEqual(recorder.calls.get('clearRetry'), ['stream-b']);
    assert.deepEqual(recorder.calls.get('releaseFollowUp'), ['stream-b']);
    assert.deepEqual(recorder.calls.get('clearBackups'), ['stream-b']);
    assert.deepEqual(recorder.calls.get('clearWebview'), ['stream-b']);
    assert.deepEqual(recorder.calls.get('deleteWebview'), ['stream-b']);
  });

  it('keeps a protected stream rendered and selected', async () => {
    const { controller, recorder, streams, activeStream } =
      createProgressStreamLifecycleHarness({
        activeStream: 'stream-a',
        protectedStreams: ['stream-a'],
      });

    await controller.deleteStream('stream-a');

    assert.deepEqual(streams(), ['stream-a', 'stream-b']);
    assert.equal(activeStream(), 'stream-a');
    assert.deepEqual(recorder.calls.get('cleanupApprovals'), undefined);
    assert.deepEqual(recorder.calls.get('deleteWebview'), undefined);
    assert.deepEqual(recorder.calls.get('retained'), ['1']);
  });

  it('deletes active finished streams and activates the next visible stream', async () => {
    const { controller, recorder, streams, activeStream } =
      createProgressStreamLifecycleHarness({
        activeStream: 'stream-a',
        visibleStreams: ['stream-b'],
      });

    await controller.deleteStream('stream-a');

    assert.deepEqual(streams(), ['stream-b']);
    assert.equal(activeStream(), 'stream-b');
    assert.deepEqual(recorder.calls.get('stop'), undefined);
    assert.deepEqual(recorder.calls.get('cleanupApprovals'), ['stream-a']);
    assert.deepEqual(recorder.calls.get('setActiveStream'), ['stream-b']);
    assert.deepEqual(recorder.calls.get('deleteWebview'), ['stream-a']);
  });

  it('skips hidden fallback streams after deleting the active stream', async () => {
    const { controller, recorder, streams, activeStream } =
      createProgressStreamLifecycleHarness({
        streams: ['stream-a', 'hidden', 'stream-c'],
        activeStream: 'stream-a',
        visibleStreams: ['stream-c'],
      });

    await controller.deleteStream('stream-a');

    assert.deepEqual(streams(), ['hidden', 'stream-c']);
    assert.equal(activeStream(), 'stream-c');
    assert.deepEqual(recorder.calls.get('setActiveStream'), ['stream-c']);
    assert.deepEqual(recorder.calls.get('deleteWebview'), ['stream-a']);
  });

  it('clears active stream when no visible fallback remains', async () => {
    const { controller, recorder, streams, activeStream } =
      createProgressStreamLifecycleHarness({
        streams: ['stream-a', 'hidden'],
        activeStream: 'stream-a',
        visibleStreams: [],
      });

    await controller.deleteStream('stream-a');

    assert.deepEqual(streams(), ['hidden']);
    assert.equal(activeStream(), '');
    assert.deepEqual(recorder.calls.get('setActiveStream'), undefined);
    assert.deepEqual(recorder.calls.get('deleteWebview'), ['stream-a']);
  });

  it('preserves stream switches that land during active stream deletion', async () => {
    const { controller, recorder, state, streams, activeStream } =
      createProgressStreamLifecycleHarness({
        streams: ['stream-a', 'stream-b', 'stream-c'],
        activeStream: 'stream-a',
        visibleStreams: ['stream-b', 'stream-c'],
      });

    const deletePromise = controller.deleteStream('stream-a');
    state.setActiveStream('stream-c');
    await deletePromise;

    assert.deepEqual(streams(), ['stream-b', 'stream-c']);
    assert.equal(activeStream(), 'stream-c');
    assert.deepEqual(recorder.calls.get('setActiveStream'), ['stream-c']);
    assert.deepEqual(recorder.calls.get('deleteWebview'), ['stream-a']);
  });

  it('stops running streams and activates the next visible stream', async () => {
    const { controller, recorder, streams, activeStream } =
      createProgressStreamLifecycleHarness({
        activeStream: 'stream-a',
        inFlightStreams: ['stream-a'],
        locallyOwnedStreams: ['stream-a'],
        protectedStreams: ['stream-a'],
        releaseProtectedOnWaitStreams: ['stream-a'],
        visibleStreams: ['stream-b'],
      });

    await controller.deleteStream('stream-a');

    assert.deepEqual(streams(), ['stream-b']);
    assert.equal(activeStream(), 'stream-b');
    assert.deepEqual(recorder.calls.get('stop'), ['stream-a']);
    assert.deepEqual(recorder.calls.get('waitForRelease'), ['stream-a']);
    assert.deepEqual(recorder.calls.get('setActiveStream'), ['stream-b']);
  });

  it('clears retry UI when stopping a stream without deleting it', async () => {
    const { controller, recorder } = createProgressStreamLifecycleHarness();

    await controller.stopStream('stream-a');

    assert.deepEqual(recorder.calls.get('clearRetry'), ['stream-a']);
    assert.deepEqual(recorder.calls.get('stop'), ['stream-a']);
    assert.deepEqual(recorder.calls.get('cleanupApprovals'), undefined);
  });

  it('clears all stream lifecycle state', async () => {
    const { controller, recorder, streams, activeStream, syncCalls } =
      createProgressStreamLifecycleHarness({
        inFlightStreams: ['stream-a', 'stream-b'],
        locallyOwnedStreams: ['stream-a', 'stream-b'],
      });

    await controller.deleteAllStreams();

    assert.deepEqual(streams(), []);
    assert.equal(activeStream(), '');
    assert.deepEqual(recorder.calls.get('stop'), ['stream-a', 'stream-b']);
    assert.deepEqual(recorder.calls.get('waitForRelease'), [
      'stream-a',
      'stream-b',
    ]);
    assert.deepEqual(recorder.calls.get('cleanupApprovals'), [
      'stream-a',
      'stream-b',
    ]);
    assert.deepEqual(recorder.calls.get('clearRetry'), [
      'stream-a',
      'stream-b',
    ]);
    assert.deepEqual(recorder.calls.get('releaseFollowUp'), [
      'stream-a',
      'stream-b',
    ]);
    assert.deepEqual(recorder.calls.get('clearBackups'), [
      'stream-a',
      'stream-b',
    ]);
    assert.deepEqual(recorder.calls.get('clearWebview'), [
      'stream-a',
      'stream-b',
    ]);
    assert.deepEqual(syncCalls, [{ forceRebuild: true }]);
  });

  it('reports streams retained by another owner during clear-all', async () => {
    const { controller, recorder, streams } =
      createProgressStreamLifecycleHarness({
        protectedStreams: ['stream-b'],
      });

    await controller.deleteAllStreams();

    assert.deepEqual(streams(), ['stream-b']);
    assert.deepEqual(recorder.calls.get('retained'), ['1']);
    assert.deepEqual(recorder.calls.get('cleanupApprovals'), ['stream-a']);
    assert.deepEqual(recorder.calls.get('clearBackups'), ['stream-a']);
    assert.deepEqual(recorder.calls.get('clearWebview'), ['stream-a']);
  });
});
