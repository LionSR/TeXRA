import '@test/support/defaultSessionTestSetup';

import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { App, type AppProps } from '@cli/chat/tui/App';
import type { InputHistory } from '@cli/chat/tui/history/inputHistory';
import {
  activeStreamId,
  infoPane,
  openInfoPane,
  patchStream,
  resetCliState,
  rootRunStartAvailable,
  rootStreamId,
} from '@cli/chat/tui/state/cliState';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import {
  FakeStdin,
  FakeStdout,
  loadInk,
} from '@test/support/inkTestHarness.mts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';

const ROOT = 'escape-root' as StreamTabId;
const ESC = String.fromCharCode(27);

function seedRootStream(): void {
  rootStreamId.set(ROOT);
  rootRunStartAvailable.set(false);
  patchStream(ROOT, (slice) => ({
    ...slice,
    status: STREAM_PHASE.RUNNING,
  }));
  activeStreamId.set(ROOT);
}

function appProps(
  onInterruptStream: (streamId: StreamTabId) => void,
): AppProps {
  return {
    onSubmit: vi.fn(),
    onKillExecution: vi.fn(),
    onSkipExecution: vi.fn(),
    onRetryExecution: vi.fn(),
    canInterruptActiveRun: () => true,
    canInterruptStream: () => true,
    onInterruptActive: vi.fn(),
    onInterruptStream,
  };
}

function fakeHistory(entries: readonly string[]): InputHistory {
  return {
    push: async () => undefined,
    reverseFind: () => undefined,
    at: (index) => entries[index],
    length: () => entries.length,
  };
}

afterEach(() => {
  resetCliState();
});

describe('App foreground Escape ownership', () => {
  it('lets a foreground information pane own Escape', async () => {
    seedRootStream();
    openInfoPane('Reference', 'Foreground content');
    const onInterruptStream = vi.fn();
    const { ink, React } = await loadInk();
    const stdin = new FakeStdin();
    const instance = ink.render(
      React.createElement(App, appProps(onInterruptStream)),
      {
        stdin,
        stdout: new FakeStdout(100, 30),
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await waitFor(() => infoPane.get() === undefined);
      await sleep(600);

      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('returns keyboard ownership to prompt history after stopping the root', async () => {
    seedRootStream();
    const onInterruptStream = vi.fn((streamId: StreamTabId) => {
      patchStream(streamId, (slice) => ({
        ...slice,
        status: STREAM_PHASE.CANCELLED,
      }));
      rootRunStartAvailable.set(true);
    });
    const { ink, React } = await loadInk();
    const stdin = new FakeStdin();
    const stdout = new FakeStdout(100, 30);
    const instance = ink.render(
      React.createElement(App, {
        ...appProps(onInterruptStream),
        history: fakeHistory(['older prompt', 'latest prompt']),
      }),
      {
        stdin,
        stdout,
        interactive: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      stdin.write('\u001b[A');
      await waitFor(() => onInterruptStream.mock.calls.length === 1);
      await waitFor(() => stdout.output.includes('latest prompt'));
      stdin.write('\u001b[A');
      await waitFor(() => stdout.output.includes('older prompt'));
      stdin.write('\u001b[B');
      await waitFor(() => stdout.output.includes('latest prompt'));

      expect(stdout.output).not.toContain('Session selection active.');
    } finally {
      instance.unmount();
    }
  });
});
