// Regression test for the patched Ink resize repaint path. Renders a minimal
// Ink app with a deliberately remounted `<Static>` band to an in-memory fake
// stdout, simulates a terminal resize by bumping `columns` and emitting
// `resize`, and asserts the highlighted band reflows to the NEW width instead
// of staying baked at the original width.
//
// This exercises the patched Ink resize full-repaint + the `<Static>` remount
// (`handleStaticChange` regenerates `fullStaticOutput` at the new width) without
// a pty (node-pty's posix_spawn is unavailable in sandboxed CI; the existing
// InkResizePatch test uses a recording stream too). The main transcript does
// not use this pattern for historical rows, because terminal scrollback is
// append-only and remounting old rows duplicates finalized output.

// Set before Ink/chalk load so reverse-video SGR (`ESC[7m`) is actually emitted
// to the non-TTY fake stdout; otherwise chalk no-ops `inverse` and the band has
// no styled fill to measure.
process.env.FORCE_COLOR ??= '3';

import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { fillRows } from '@cli/chat/tui/render/terminalText';
import { delay } from '@utils/core';

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

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

/** Widest visible reverse-video (`ESC[7m…ESC[27m`) run that contains the band. */
function bandWidth(output: string): number {
  let widest = 0;
  // eslint-disable-next-line no-control-regex -- matching raw SGR escapes
  const run = /\x1b\[7m([\s\S]*?)\x1b\[(?:27|0)m/g;
  // eslint-disable-next-line no-control-regex -- stripping raw SGR escapes
  const sgr = /\x1b\[[0-9;]*[A-Za-z]/g;
  let match: RegExpExecArray | null;
  while ((match = run.exec(output))) {
    const visible = match[1].replaceAll(sgr, '');
    if (visible.includes('hi')) widest = Math.max(widest, visible.length);
  }
  return widest;
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
  it('reflows the user band to the new width on resize', async () => {
    // Dynamic import so FORCE_COLOR is set first and the patched workspace Ink
    // (not a hoisted copy) is loaded.
    const ink = (await import(cliRequire.resolve('ink'))) as any;
    const React = ((await import(cliRequire.resolve('react'))) as any).default;
    const { useState, useEffect, createElement } = React;

    function App(): unknown {
      const { stdout } = ink.useStdout();
      const [cols, setCols] = useState(stdout.columns || 80);
      useEffect(() => {
        const onResize = (): void => setCols(stdout.columns || 80);
        stdout.on('resize', onResize);
        return () => stdout.off('resize', onResize);
      }, [stdout]);
      return createElement(ink.Static, { key: cols, items: [0] }, () =>
        createElement(
          ink.Box,
          { key: 'band' },
          createElement(ink.Text, { inverse: true }, fillRows('> hi', cols)),
        ),
      );
    }

    const out = new FakeStdout(40);
    const inst = ink.render(createElement(App), {
      stdout: out,
      stdin: new FakeStdin(),
      exitOnCtrlC: false,
      patchConsole: false,
    });

    try {
      expect(await waitFor(() => bandWidth(out.buf) >= 40, 5000)).toBe(true);
      expect(bandWidth(out.buf)).toBe(40);

      // Widen: bump columns and fire the resize the patched Ink handler listens
      // for. Clear the buffer so we measure only the post-resize repaint.
      out.buf = '';
      out.columns = 80;
      out.emit('resize');

      expect(await waitFor(() => bandWidth(out.buf) >= 80, 5000)).toBe(true);
      expect(bandWidth(out.buf)).toBe(80);
    } finally {
      inst.unmount();
    }
  });
});
