// Standard library imports
import { strict as assert } from 'assert';

// Local imports - progress view
import { ProgressViewProvider } from '@progressView/ProgressViewProvider';

// Local imports - agent
import type { StreamTabId } from '@agent/types/IdentifierTypes';

describe('ProgressViewProvider.clearTaskOutput', () => {
  it('delegates to ProgressViewState.clearOutputState and refreshes the webview', () => {
    const calls: StreamTabId[] = [];
    let updateCount = 0;
    const provider = {
      state: {
        clearOutputState: (stream: StreamTabId) => {
          calls.push(stream);
          return true;
        },
      },
      updateWebview: () => {
        updateCount += 1;
      },
    } as unknown as ProgressViewProvider;

    ProgressViewProvider.prototype.clearTaskOutput.call(
      provider,
      'stream-1' as StreamTabId,
    );

    assert.deepStrictEqual(calls, ['stream-1']);
    assert.equal(updateCount, 1);
  });

  it('skips the webview update when no state change occurs', () => {
    let updateCount = 0;
    const provider = {
      state: {
        clearOutputState: () => false,
      },
      updateWebview: () => {
        updateCount += 1;
      },
    } as unknown as ProgressViewProvider;

    ProgressViewProvider.prototype.clearTaskOutput.call(
      provider,
      'stream-2' as StreamTabId,
    );

    assert.equal(updateCount, 0);
  });
});
