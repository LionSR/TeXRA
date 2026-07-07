import { strict as assert } from 'node:assert';
import { describe, it } from 'vitest';

import type { AgentTrace } from '@agent/trace';
import type { ProgressViewState } from '@shared/progressView/backend/state/ProgressViewState';
import {
  createDesktopProgressEventBridge,
  type DesktopProgressEventBridgeOptions,
} from '@desktop/main/desktopProgressEventBridge';

/**
 * Regression test for #7377: a headless run can keep the owning bridge's
 * `hostChannel.emit` closure after the desktop window closed and the bridge was
 * disposed. Events delivered through that second route (the one #7372 left
 * unguarded) must no-op — they must not re-route the renderer, re-show root
 * errors, or otherwise touch torn-down state.
 */
function makeBridge() {
  const calls = { showError: [] as string[], routeToProgress: 0 };
  const options: DesktopProgressEventBridgeOptions = {
    // Only the requestShowError / requestEnsureProgressView paths are exercised;
    // neither dereferences `state`, and with no snapshot store constructor-time
    // hydration is a no-op, so a cast placeholder is sufficient here.
    state: {} as ProgressViewState,
    streamStatus: { get: () => undefined, transition: () => undefined },
    streamSnapshotStore: undefined,
    sendMessage: () => undefined,
    logger: { warn: () => undefined } as unknown as AgentTrace,
    getActiveStream: () => '',
    routeToProgress: () => {
      calls.routeToProgress += 1;
    },
    onGoalStateChanged: () => undefined,
    onShowError: (message) => {
      calls.showError.push(message);
    },
  };
  return { bridge: createDesktopProgressEventBridge(options), calls };
}

describe('DesktopProgressEventBridge dispose guard (#7377)', () => {
  it('routes events before dispose', () => {
    const { bridge, calls } = makeBridge();

    bridge.onProgressEvent('requestShowError', { message: 'boom' });
    bridge.onProgressEvent('requestEnsureProgressView', {});

    assert.deepEqual(calls.showError, ['boom']);
    assert.equal(calls.routeToProgress, 1);
  });

  it('no-ops progress events delivered after dispose', () => {
    const { bridge, calls } = makeBridge();

    bridge.dispose();

    assert.doesNotThrow(() => {
      bridge.onProgressEvent('requestShowError', { message: 'after-dispose' });
      bridge.onProgressEvent('requestEnsureProgressView', {});
    });

    assert.deepEqual(calls.showError, []);
    assert.equal(calls.routeToProgress, 0);
  });
});
