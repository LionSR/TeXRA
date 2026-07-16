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

// Node.js imports
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

// Third-party imports
import stripAnsi from 'strip-ansi';
import { afterAll, describe, expect, it } from 'vitest';

// Local imports
import type { ConversationEntry } from '@cli/chat/tui/state/cliState';
import { AgentCategory, type StreamTabId } from '@shared/schemas';
import { delay } from '@utils/core';

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

afterAll(() => {
  for (const [name, value] of Object.entries(ORIGINAL_COLOR_ENV)) {
    if (value == null) delete process.env[name];
    else process.env[name] = value;
  }
});

class FakeStdout extends EventEmitter {
  isTTY = true;
  rows = 12;
  buf = '';
  constructor(public columns: number) {
    super();
  }
  write(chunk: string): boolean {
    this.buf += chunk;
    return true;
  }
  getColorDepth(): number {
    return 24;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = false;
  ref(): void {}
  unref(): void {}
  pause(): void {}
  resume(): void {}
  setEncoding(): void {}
  read(): null {
    return null;
  }
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

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(25);
  }
  return predicate();
}

describe('Static band resize', () => {
  it('replaces finalized transcript geometry at the new width', async () => {
    // Dynamic import so FORCE_COLOR is set first and the patched workspace Ink
    // (not a hoisted copy) is loaded.
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
    const { createElement } = React;
    const { StaticConversationTranscript } =
      await import('@cli/chat/tui/panes/StaticConversationTranscript');
    const { patchStream, resetCliState } =
      await import('@cli/chat/tui/state/cliState');
    const inkRequire = createRequire(cliRequire.resolve('ink'));
    const { clearTerminal } = inkRequire('ansi-escapes') as {
      readonly clearTerminal: string;
    };
    const streamId = 'resize-static-stream' as StreamTabId;
    const prompt = 'resize geometry prompt';
    const finalizedUser: ConversationEntry = {
      id: 'resize-user',
      role: 'user',
      text: prompt,
      finalized: true,
    };
    const liveAssistant: ConversationEntry = {
      id: 'live-assistant',
      role: 'assistant',
      text: 'working',
      finalized: false,
    };

    resetCliState({
      agent: 'research',
      category: AgentCategory.ToolUse,
      model: 'test-model',
      modelSource: 'builtin-default',
      cwd: '/tmp/resize-proof',
      apiMode: 'personal',
      approvalPolicy: 'ask',
      canDelegate: false,
      transcriptMode: 'persistent',
      version: '0.0.0-test',
    });
    patchStream(streamId, (slice) => ({
      ...slice,
      entries: [finalizedUser, liveAssistant],
    }));

    function App(): unknown {
      const { columns } = ink.useWindowSize();
      return createElement(StaticConversationTranscript, {
        colorEnabled: true,
        ownerKey: 'resize-owner',
        scrollbackStreamId: streamId,
        width: columns,
      });
    }

    const out = new FakeStdout(40);
    const inst = ink.render(createElement(App), {
      stdout: out,
      stdin: new FakeStdin(),
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      expect(
        await waitFor(
          () =>
            horizontalRuleWidths(out.buf).includes(40) &&
            inverseBandWidths(out.buf, prompt).includes(38),
          5000,
        ),
      ).toBe(true);

      // Widen: bump columns and fire the resize the patched Ink handler listens
      // for. Clear the recording so the final frame cannot pass using initial
      // output.
      out.buf = '';
      out.columns = 80;
      out.emit('resize');

      expect(await waitFor(() => out.buf.includes(clearTerminal), 5000)).toBe(
        true,
      );
      const frame = latestRepaintFrame(out.buf, clearTerminal);
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
      resetCliState();
    }
  });

  it('keeps resize subscriptions constant as tool history grows', async () => {
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
    const { createElement } = React;
    const { StaticConversationTranscript } =
      await import('@cli/chat/tui/panes/StaticConversationTranscript');
    const { patchStream, resetCliState } =
      await import('@cli/chat/tui/state/cliState');
    const streamId = 'listener-count-stream' as StreamTabId;
    const toolEntries: ConversationEntry[] = Array.from(
      { length: 70 },
      (_, index) => ({
        id: `tool-${index}`,
        role: 'tool' as const,
        text: '',
        finalized: true,
        toolUse: {
          parsed: {},
          toolName: 'Bash',
          errorText: '',
          outputText: `result ${index}`,
          userInstructionText: '',
          input: { command: `printf ${index}` },
          isError: false,
          isUserFeedback: false,
          headerSummary: '',
          status: 'completed' as const,
        },
      }),
    );

    resetCliState({
      agent: 'research',
      category: AgentCategory.ToolUse,
      model: 'test-model',
      modelSource: 'builtin-default',
      cwd: '/tmp/listener-proof',
      apiMode: 'personal',
      approvalPolicy: 'ask',
      canDelegate: false,
      transcriptMode: 'persistent',
      version: '0.0.0-test',
    });
    patchStream(streamId, (slice) => ({ ...slice, entries: toolEntries }));

    function App(): unknown {
      const { columns } = ink.useWindowSize();
      return createElement(StaticConversationTranscript, {
        ownerKey: 'listener-owner',
        scrollbackStreamId: streamId,
        width: columns,
      });
    }

    const out = new FakeStdout(80);
    let peakResizeListeners = 0;
    out.on('newListener', (event) => {
      if (event === 'resize') {
        peakResizeListeners = Math.max(
          peakResizeListeners,
          out.listenerCount('resize') + 1,
        );
      }
    });
    const inst = ink.render(createElement(App), {
      stdout: out,
      stdin: new FakeStdin(),
      interactive: true,
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      expect(await waitFor(() => out.buf.includes('result 69'), 5000)).toBe(
        true,
      );
      // One listener belongs to Ink's renderer and one to the App-level
      // useWindowSize subscription. Transcript length must not affect it.
      expect(peakResizeListeners).toBe(2);
    } finally {
      inst.unmount();
      resetCliState();
    }
  });
});
