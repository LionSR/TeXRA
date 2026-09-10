// Regression test for the production transcript's patched Ink resize path.
// An in-memory stdout exposes the exact clear-and-repaint frame, which is the
// reliable boundary for proving that Ink replaced its accumulated `<Static>`
// output. A PTY adds emulator reflow but cannot reveal stale rows that the same
// repaint subsequently clears.

// Set before Ink/chalk load so reverse-video SGR (`ESC[7m`) is emitted to the
// in-memory TTY; otherwise chalk no-ops `inverse` and the band has no styled
// fill to measure.
const ORIGINAL_COLOR_ENV = {
  FORCE_COLOR: process.env.FORCE_COLOR,
  NO_COLOR: process.env.NO_COLOR,
};
delete process.env.NO_COLOR;
process.env.FORCE_COLOR = '3';

// Third-party imports
import stripAnsi from 'strip-ansi';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Local imports
import type { TuiRepaintOptions } from '@cli/chat/tui/render/tuiViewportController';
import type { SessionMeta } from '@cli/chat/tui/state/cliState';
import type { RunId } from '@shared/schemas';
import type { TranscriptRow } from '@shared/transcript';
import {
  FakeStdin,
  FakeStdout,
  loadInk,
  renderInteractive,
  renderWithTerminalSize,
} from '@test/support/inkTestHarness.ts';
import { pollForCondition } from '@test/support/asyncTestUtils';
import {
  textRowFixture,
  toolRowFixture,
} from '@test/support/transcriptRowFixtures';
import {
  bindTestSessionView,
  makeRunView,
  seedView,
  viewWith,
} from './fixtures/sessionViewFixture';

afterAll(() => {
  for (const [name, value] of Object.entries(ORIGINAL_COLOR_ENV)) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
});

const TRANSCRIPT_SESSION: Omit<SessionMeta, 'cwd'> = {
  agent: 'research',
  model: 'test-model',
  modelSource: 'builtin-default',
  approvalPolicy: 'ask',
  version: '0.0.0-test',
};

/** Poll until the frame under test appears, asserting it arrived in time. */
async function expectEventually(check: () => boolean): Promise<void> {
  expect(
    await pollForCondition(check, { timeoutMs: 5000, intervalMs: 25 }),
  ).toBe(true);
}

function inverseBandWidths(output: string, text: string): readonly number[] {
  const widths: number[] = [];
  // eslint-disable-next-line no-control-regex -- matching raw SGR escapes
  const run = /\x1b\[7m([\s\S]*?)\x1b\[(?:27|0)m/g;
  // eslint-disable-next-line no-control-regex -- stripping raw SGR escapes
  const sgr = /\x1b\[[0-9;]*[A-Za-z]/g;
  let match: RegExpExecArray | null;
  while ((match = run.exec(output))) {
    const visible = match[1].replaceAll(sgr, '');
    if (visible.includes(text)) widths.push(visible.length);
  }
  return widths;
}

function horizontalRuleWidths(output: string): readonly number[] {
  return stripAnsi(output)
    .split('\n')
    .filter((line) => /^─+$/u.test(line))
    .map((line) => line.length);
}

function latestRepaintFrame(output: string, clearTerminal: string): string {
  const clearIndex = output.lastIndexOf(clearTerminal);
  return clearIndex < 0 ? '' : output.slice(clearIndex + clearTerminal.length);
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

/**
 * Shared dynamic imports — every case must load Ink and the transcript pane
 * only after FORCE_COLOR is set above, so the patched workspace Ink (not a
 * hoisted copy) is the one under test.
 */
async function loadTranscriptStack() {
  const inkStack = await loadInk();
  const { StaticConversationTranscript } =
    await import('@cli/chat/tui/panes/StaticConversationTranscript');
  const cliState = await import('@cli/chat/tui/state/cliState');
  const { clearTerminal } = inkStack.requireFromInk('ansi-escapes') as {
    readonly clearTerminal: string;
  };
  return { ...inkStack, cliState, clearTerminal, StaticConversationTranscript };
}

function seedTranscript(
  cliState: typeof import('@cli/chat/tui/state/cliState'),
  runId: RunId,
  cwd: string,
  entries: TranscriptRow[],
): void {
  cliState.resetCliState({ ...TRANSCRIPT_SESSION, cwd });
  seedView(
    viewWith([
      makeRunView({
        id: runId,
        transcript: {
          rows: entries,
          taskGroups: [],
          settledRows: entries.length,
          run: null,
        },
      }),
    ]),
  );
}

/** A completed tool row; only the fields each case varies are parameters. A
 *  `settlementSeqNo` is what makes the row settled on arrival, so the static
 *  band can print it without waiting for the promotion frontier. */
function completedToolEntry(fields: {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  outputText: string;
  settlementSeqNo?: number;
}): TranscriptRow {
  return toolRowFixture(
    fields.id,
    {
      toolName: fields.toolName,
      input: fields.input,
      outputText: fields.outputText,
    },
    fields.settlementSeqNo,
  );
}

describe('Static band resize', () => {
  beforeAll(bindTestSessionView);
  it('replaces finalized transcript geometry at the new width', async () => {
    const {
      ink,
      React,
      cliState,
      clearTerminal,
      StaticConversationTranscript,
    } = await loadTranscriptStack();
    const { createElement } = React;
    const runId = 'resize-static-stream' as RunId;
    const prompt = 'resize geometry prompt';
    // A user row is settled on arrival; the assistant and tool rows carry no
    // settlement order, so they stay live.
    const finalizedUser = textRowFixture('resize-user', 'user', prompt);
    const liveAssistant = textRowFixture(
      'live-assistant',
      'assistant',
      'working',
    );
    const tool = completedToolEntry({
      id: 'full-output-tool',
      toolName: 'Bash',
      input: { command: 'long-command' },
      outputText: Array.from(
        { length: 15 },
        (_, index) => `tool line ${index}`,
      ).join('\n'),
    });

    seedTranscript(cliState, runId, '/tmp/resize-proof', [
      finalizedUser,
      liveAssistant,
      tool,
    ]);

    function App(): unknown {
      const { columns } = ink.useWindowSize();
      return createElement(StaticConversationTranscript, {
        colorEnabled: true,
        ownerKey: 'resize-owner',
        scrollbackRunId: runId,
        width: columns,
      });
    }

    const { instance: inst, stdout: out } = renderWithTerminalSize(
      ink,
      createElement(App),
      40,
      12,
    );

    try {
      await expectEventually(
        () =>
          horizontalRuleWidths(out.output).includes(40) &&
          inverseBandWidths(out.output, prompt).includes(38),
      );

      // Widen: bump columns and fire the resize the patched Ink handler listens
      // for. Clear the recording so the final frame cannot pass using initial
      // output.
      out.output = '';
      out.columns = 80;
      out.emit('resize');

      await expectEventually(() => out.output.includes(clearTerminal));
      const frame = latestRepaintFrame(out.output, clearTerminal);
      const ruleWidths = horizontalRuleWidths(frame);
      const bandWidths = inverseBandWidths(frame, prompt);
      const visibleFrame = stripAnsi(frame);

      expect(ruleWidths).toEqual([80]);
      expect(ruleWidths).not.toContain(40);
      expect(bandWidths).toEqual([78]);
      expect(bandWidths).not.toContain(38);
      expect(occurrences(visibleFrame, '{ T } TeXRA')).toBe(1);
      expect(occurrences(visibleFrame, `› ${prompt}`)).toBe(1);
    } finally {
      inst.unmount();
      cliState.resetCliState();
    }
  });

  it('replaces finalized run rows when subagent labels arrive', async () => {
    const {
      ink,
      React,
      cliState,
      clearTerminal,
      StaticConversationTranscript,
    } = await loadTranscriptStack();
    const { createElement } = React;
    const runId = 'run-label-stream' as RunId;
    const runId = 'late-subagent-id';
    const runPath = `/executions/${runId}/report`;
    const runEntry = completedToolEntry({
      id: 'run-view',
      toolName: 'executions',
      input: { path: runPath },
      outputText: 'report',
      settlementSeqNo: 1,
    });

    seedTranscript(cliState, runId, '/tmp/run-label-proof', [
      runEntry,
    ]);

    const inkRef: {
      current?: { repaint(options: TuiRepaintOptions): void };
    } = {};
    function App({ labels }: { labels: ReadonlyMap<string, string> }): unknown {
      // The render key is label-agnostic, as in ConversationRegion: the
      // transcript state owns the label-change repaint through its epoch.
      const renderKey = 'run-label-render';
      return createElement(StaticConversationTranscript, {
        onRenderKeyChange: () => {
          inkRef.current?.repaint({
            clearScrollback: true,
            preserveStatic: false,
          });
        },
        ownerKey: 'run-label-owner',
        renderKey,
        scrollbackRunId: runId,
        subagentRunLabels: labels,
        width: 80,
      });
    }

    const { instance: inst, stdout: out } = renderWithTerminalSize(
      ink,
      createElement(App, { labels: new Map() }),
      80,
      12,
    );
    inkRef.current = inst;

    try {
      await expectEventually(() => out.output.includes(runPath));

      out.output = '';
      inst.rerender(
        createElement(App, {
          labels: new Map([[runId, 'reviewer']]),
        }),
      );

      await expectEventually(() => out.output.includes(clearTerminal));
      const frame = stripAnsi(latestRepaintFrame(out.output, clearTerminal));
      expect(frame).toContain('executions (view: reviewer/report)');
      expect(frame).not.toContain(runPath);
      expect(occurrences(frame, 'executions (view: reviewer/report)')).toBe(1);
    } finally {
      inst.unmount();
      cliState.resetCliState();
    }
  });

  it('keeps resize subscriptions constant as tool history grows', async () => {
    const { ink, React, cliState, StaticConversationTranscript } =
      await loadTranscriptStack();
    const { createElement } = React;
    const runId = 'listener-count-stream' as RunId;
    const toolEntries: TranscriptRow[] = Array.from(
      { length: 70 },
      (_, index) =>
        completedToolEntry({
          id: `tool-${index}`,
          toolName: 'Bash',
          input: { command: `printf ${index}` },
          outputText: `result ${index}`,
          settlementSeqNo: index + 1,
        }),
    );

    seedTranscript(cliState, runId, '/tmp/listener-proof', toolEntries);

    function App(): unknown {
      const { columns } = ink.useWindowSize();
      return createElement(StaticConversationTranscript, {
        ownerKey: 'listener-owner',
        scrollbackRunId: runId,
        width: columns,
      });
    }

    const out = new FakeStdout(80, 12);
    let peakResizeListeners = 0;
    out.on('newListener', (event) => {
      if (event === 'resize') {
        peakResizeListeners = Math.max(
          peakResizeListeners,
          out.listenerCount('resize') + 1,
        );
      }
    });
    const { instance: inst } = renderInteractive(ink, createElement(App), {
      stdout: out,
      stdin: new FakeStdin(false),
    });

    try {
      await expectEventually(() => out.output.includes('result 69'));
      // One listener belongs to Ink's renderer and one to the App-level
      // useWindowSize subscription. Transcript length must not affect it.
      expect(peakResizeListeners).toBe(2);
    } finally {
      inst.unmount();
      cliState.resetCliState();
    }
    expect(out.listenerCount('resize')).toBe(0);
  });
});
