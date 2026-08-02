import '@test/support/defaultSessionTestSetup';

import { setTimeout as sleep } from 'node:timers/promises';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App, type AppProps } from '@cli/chat/tui/App';
import type { InputHistory } from '@cli/chat/tui/history/inputHistory';
import {
  activeStreamId,
  focusStream,
  infoPane,
  openInfoPane,
  resetCliState,
  rootRunStartAvailable,
  rootStreamId,
  setStreamStatusInCliState,
} from '@cli/chat/tui/state/cliState';
import {
  applySubagentRoster,
  setParentStream,
} from '@cli/chat/tui/state/childExecutions';
import { STREAM_PHASE, type StreamTabId } from '@shared/schemas';
import {
  loadInk,
  renderInteractive,
  type InkRenderHandles,
} from '@test/support/inkTestHarness.mts';
import { waitForCondition as waitFor } from '@test/support/asyncTestUtils';

vi.mock('@cli/runtime/shortcutLabels', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@cli/runtime/shortcutLabels')>();
  return { ...actual, defaultShortcutModifierLabel: () => 'Esc' };
});

const ROOT = 'escape-root' as StreamTabId;
const CHILD = 'escape-child' as StreamTabId;
const GRANDCHILD = 'escape-grandchild' as StreamTabId;
const ESC = String.fromCharCode(27);

function seedRootStream(): void {
  rootStreamId.set(ROOT);
  rootRunStartAvailable.set(false);
  setStreamStatusInCliState({
    streamId: ROOT,
    status: STREAM_PHASE.RUNNING,
  });
  focusStream(ROOT);
}

function seedChildHierarchy(): void {
  seedRootStream();
  for (const streamId of [CHILD, GRANDCHILD]) {
    setStreamStatusInCliState({
      streamId,
      status: STREAM_PHASE.RUNNING,
    });
  }
  applySubagentRoster(ROOT, [
    {
      kind: 'subagent',
      executionId: 'escape-child-execution',
      agentName: 'child',
      childStreamId: CHILD,
      status: STREAM_PHASE.RUNNING,
    },
  ]);
  applySubagentRoster(CHILD, [
    {
      kind: 'subagent',
      executionId: 'escape-grandchild-execution',
      agentName: 'grandchild',
      childStreamId: GRANDCHILD,
      status: STREAM_PHASE.RUNNING,
    },
  ]);
  setParentStream(CHILD, ROOT);
  setParentStream(GRANDCHILD, CHILD);
}

function finishNestedHierarchyAndFocusRoot(): void {
  for (const streamId of [GRANDCHILD, CHILD]) {
    setStreamStatusInCliState({
      streamId,
      status: STREAM_PHASE.COMPLETED,
    });
  }
  focusStream(ROOT);
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

async function renderApp(props: AppProps): Promise<InkRenderHandles> {
  const { ink, React } = await loadInk();
  return renderInteractive(ink, React.createElement(App, props), {
    columns: 100,
    rows: 30,
  });
}

function fakeHistory(entries: readonly string[]): InputHistory {
  return {
    push: async () => undefined,
    reverseFind: () => undefined,
    at: (index) => entries[index],
    length: () => entries.length,
  };
}

beforeEach(() => resetCliState());
afterEach(() => resetCliState());

describe('App foreground Escape ownership', () => {
  it('lets a foreground information pane own Escape before child back', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    openInfoPane('Reference', 'Foreground content');
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await waitFor(() => infoPane.get() === undefined);
      await sleep(600);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('walks nested children back one immediate parent per bare Escape', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === CHILD);
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === ROOT);

      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('does not apply delayed child back after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      openInfoPane('Late reference', 'Foreground content');
      await waitFor(() => infoPane.get()?.title === 'Late reference');
      await sleep(600);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late reference');
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('discards delayed child back after lifecycle focus advances', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      finishNestedHierarchyAndFocusRoot();
      await waitFor(() => activeStreamId.get() === ROOT);
      await sleep(600);

      expect(activeStreamId.get()).toBe(ROOT);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('discards delayed child back when the child is promoted', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      setParentStream(CHILD, null);
      await sleep(600);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('does not apply failed-chord child back after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      openInfoPane('Late failed-chord reference', 'Foreground content');
      await waitFor(
        () => infoPane.get()?.title === 'Late failed-chord reference',
      );
      stdin.write('x');
      await sleep(50);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late failed-chord reference');
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('preserves a printable failed chord when back enables parent input', async () => {
    seedChildHierarchy();
    setStreamStatusInCliState({
      streamId: CHILD,
      status: STREAM_PHASE.COMPLETED,
    });
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const onSubmit = vi.fn();
    const { instance, stdin } = await renderApp({
      ...appProps(onInterruptStream),
      onSubmit,
    });

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      stdin.write('q');
      await waitFor(() => activeStreamId.get() === ROOT);
      stdin.write('\r');
      await waitFor(() => onSubmit.mock.calls.length === 1);

      expect(onSubmit).toHaveBeenCalledWith('q', undefined);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('does not duplicate a printable failed chord from enabled input', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const onSubmit = vi.fn();
    const { instance, stdin } = await renderApp({
      ...appProps(onInterruptStream),
      onSubmit,
    });

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      stdin.write('q');
      await waitFor(() => activeStreamId.get() === ROOT);
      stdin.write('\r');
      await waitFor(() => onSubmit.mock.calls.length === 1);

      expect(onSubmit).toHaveBeenCalledWith('q', undefined);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it.each([
    ['Up', '\u001B[A'],
    ['Down', '\u001B[B'],
    ['Right', '\u001B[C'],
    ['Left', '\u001B[D'],
  ])('resolves deferred child back before %s', async (_name, arrowInput) => {
    seedChildHierarchy();
    setStreamStatusInCliState({
      streamId: CHILD,
      status: STREAM_PHASE.COMPLETED,
    });
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const onSubmit = vi.fn();
    const { instance, stdin } = await renderApp({
      ...appProps(onInterruptStream),
      onSubmit,
    });

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      stdin.write(arrowInput);
      await waitFor(() => activeStreamId.get() === ROOT);
      stdin.write('\r');
      await sleep(30);

      expect(onInterruptStream).not.toHaveBeenCalled();
      expect(onSubmit).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('discards failed-chord child back after lifecycle focus advances', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      finishNestedHierarchyAndFocusRoot();
      await waitFor(() => activeStreamId.get() === ROOT);
      stdin.write('x');
      await sleep(50);

      expect(activeStreamId.get()).toBe(ROOT);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('discards failed-chord child back when the child is promoted', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      setParentStream(CHILD, null);
      stdin.write('x');
      await sleep(50);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('does not resolve Esc-digit focus after a foreground pane opens', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      openInfoPane('Late chord reference', 'Foreground content');
      await waitFor(() => infoPane.get()?.title === 'Late chord reference');
      stdin.write('1');
      await sleep(600);

      expect(activeStreamId.get()).toBe(CHILD);
      expect(infoPane.get()?.title).toBe('Late chord reference');
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('preserves two quick bare-Escape actions through the chord window', async () => {
    seedChildHierarchy();
    focusStream(GRANDCHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      stdin.write(ESC);
      await waitFor(() => activeStreamId.get() === CHILD);
      await waitFor(() => activeStreamId.get() === ROOT);

      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('interrupts the root only once for two quick bare Escapes', async () => {
    seedChildHierarchy();
    focusStream(ROOT);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      stdin.write(ESC);
      await waitFor(() => onInterruptStream.mock.calls.length >= 1);
      await sleep(600);

      expect(activeStreamId.get()).toBe(ROOT);
      expect(onInterruptStream).toHaveBeenCalledOnce();
      expect(onInterruptStream).toHaveBeenCalledWith(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('keeps an Esc-digit focus target after the bare-Escape window expires', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await sleep(50);
      stdin.write('1');
      await waitFor(() => activeStreamId.get() === GRANDCHILD);
      await sleep(600);

      expect(activeStreamId.get()).toBe(GRANDCHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();
    } finally {
      instance.unmount();
    }
  });

  it('treats list Escape as cancel and Tab as the explicit ownership transfer', async () => {
    seedChildHierarchy();
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin, stdout } = await renderApp(
      appProps(onInterruptStream),
    );

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write('\t');
      await waitFor(() => stdout.output.includes('Session selection active.'));
      const beforeListCancel = stdout.output.length;
      stdin.write(ESC);
      await waitFor(() =>
        stdout.output.slice(beforeListCancel).includes('Esc back'),
      );

      expect(activeStreamId.get()).toBe(CHILD);
      expect(onInterruptStream).not.toHaveBeenCalled();

      const beforeListFocus = stdout.output.length;
      stdin.write('\t');
      await waitFor(() =>
        stdout.output
          .slice(beforeListFocus)
          .includes('Session selection active.'),
      );
      const beforeTabReturn = stdout.output.length;
      stdin.write('\t');
      await waitFor(() =>
        stdout.output.slice(beforeTabReturn).includes('Esc back'),
      );
    } finally {
      instance.unmount();
    }
  });

  it('does not transfer idle input arrows to an available child list', async () => {
    seedChildHierarchy();
    focusStream(ROOT);
    const { instance, stdin, stdout } = await renderApp(appProps(vi.fn()));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      for (const arrowInput of [
        '\u001B[A',
        '\u001B[B',
        '\u001B[C',
        '\u001B[D',
      ]) {
        stdin.write(arrowInput);
      }
      await sleep(30);

      expect(stdout.output).not.toContain('Session selection active.');
      expect(activeStreamId.get()).toBe(ROOT);
    } finally {
      instance.unmount();
    }
  });

  it('interrupts a promoted top-level stream because it has no back relation', async () => {
    seedChildHierarchy();
    setParentStream(CHILD, null);
    focusStream(CHILD);
    const onInterruptStream = vi.fn();
    const { instance, stdin } = await renderApp(appProps(onInterruptStream));

    try {
      await waitFor(() => stdin.listenerCount('readable') > 0);
      stdin.write(ESC);
      await waitFor(() => onInterruptStream.mock.calls.length === 1);

      expect(onInterruptStream).toHaveBeenCalledWith(CHILD);
      expect(activeStreamId.get()).toBe(CHILD);
    } finally {
      instance.unmount();
    }
  });

  it('returns keyboard ownership to prompt history after stopping the root', async () => {
    seedRootStream();
    const onInterruptStream = vi.fn((streamId: StreamTabId) => {
      setStreamStatusInCliState({
        streamId: streamId,
        status: STREAM_PHASE.CANCELLED,
      });
      rootRunStartAvailable.set(true);
    });
    const { instance, stdin, stdout } = await renderApp({
      ...appProps(onInterruptStream),
      history: fakeHistory(['older prompt', 'latest prompt']),
    });

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
