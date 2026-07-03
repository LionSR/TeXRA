import { describe, expect, it } from 'vitest';

import {
  annotateStreamFailure,
  detectPartialText,
  requiresFlowAutoRetry,
  trackStreamConnect,
  type ConnectTrackableStream,
} from '@common/errors/sdkErrorUtils';

/** Minimal fake of a provider stream's `connect` event emitter. */
function fakeStream(): ConnectTrackableStream & {
  emitConnect: () => void;
  offCalls: number;
} {
  const listeners: Array<() => void> = [];
  return {
    on(_event, listener) {
      listeners.push(listener);
    },
    off(_event, listener) {
      const i = listeners.indexOf(listener);
      if (i >= 0) listeners.splice(i, 1);
      this.offCalls += 1;
    },
    emitConnect() {
      for (const l of listeners) l();
    },
    offCalls: 0,
  };
}

describe('trackStreamConnect', () => {
  it('reports connected only after the connect event fires', () => {
    const stream = fakeStream();
    const tracker = trackStreamConnect(stream);
    expect(tracker.isConnected()).toBe(false);
    stream.emitConnect();
    expect(tracker.isConnected()).toBe(true);
  });

  it('cleanup removes the connect listener', () => {
    const stream = fakeStream();
    const tracker = trackStreamConnect(stream);
    tracker.cleanup();
    expect(stream.offCalls).toBe(1);
    // A late connect event after cleanup must not flip the flag.
    stream.emitConnect();
    expect(tracker.isConnected()).toBe(false);
  });

  it('stays inert after cleanup even when the stream has no off method', () => {
    const listeners: Array<() => void> = [];
    const stream: ConnectTrackableStream = {
      on: (_e, listener) => listeners.push(listener),
    };
    const tracker = trackStreamConnect(stream);
    expect(() => tracker.cleanup()).not.toThrow();
    // The listener can't be detached, but a late connect event must not flip
    // the flag once the tracker has been cleaned up.
    for (const l of listeners) l();
    expect(tracker.isConnected()).toBe(false);
  });
});

describe('annotateStreamFailure', () => {
  it('attaches partial text and marks retry when eligible', () => {
    const err = new Error('boom');
    annotateStreamFailure(err, 'partial tail', true);
    expect(detectPartialText(err)).toBe('partial tail');
    expect(requiresFlowAutoRetry(err)).toBe(true);
  });

  it('does not mark retry when ineligible', () => {
    const err = new Error('boom');
    annotateStreamFailure(err, 'partial tail', false);
    expect(detectPartialText(err)).toBe('partial tail');
    expect(requiresFlowAutoRetry(err)).toBe(false);
  });

  it('no-ops partial-text attach for an empty tail', () => {
    const err = new Error('boom');
    annotateStreamFailure(err, '', true);
    expect(detectPartialText(err)).toBeUndefined();
    expect(requiresFlowAutoRetry(err)).toBe(true);
  });
});
