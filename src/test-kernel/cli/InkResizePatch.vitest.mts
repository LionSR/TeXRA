import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

type LogUpdateRenderer = {
  (value: string): boolean;
  clear(): void;
  clearWidthAware(columns: number): void;
  setCursorPosition(position: { x: number; y: number }): void;
};

type LogUpdateModule = {
  default: {
    create(
      stream: { isTTY: boolean; columns: number; write(chunk: string): void },
      options: { showCursor: boolean },
    ): LogUpdateRenderer;
  };
};

function createRecordingStream() {
  let writes: string[] = [];
  return {
    isTTY: true,
    columns: 80,
    write(chunk: string) {
      writes.push(String(chunk));
    },
    output() {
      return writes.join('');
    },
    reset() {
      writes = [];
    },
  };
}

function countEraseLines(output: string): number {
  return output.split('\u001B[2K').length - 1;
}

async function loadCliLogUpdate() {
  const cliRequire = createRequire(
    new URL('../../../packages/cli/package.json', import.meta.url),
  );
  const inkMain = cliRequire.resolve('ink');
  const logUpdatePath = path.join(path.dirname(inkMain), 'log-update.js');
  return (await import(pathToFileURL(logUpdatePath).href)) as LogUpdateModule;
}

describe('CLI Ink resize patch', () => {
  it('clears physical wrapped rows after terminal resize', async () => {
    const { default: logUpdate } = await loadCliLogUpdate();
    const stream = createRecordingStream();
    const render = logUpdate.create(stream, { showCursor: true });
    const longLine = 'x'.repeat(95);

    render(longLine);
    stream.reset();
    render.clear();
    const logicalEraseLines = countEraseLines(stream.output());

    render(longLine);
    stream.reset();
    render.clearWidthAware(30);
    const widthAwareEraseLines = countEraseLines(stream.output());

    expect(logicalEraseLines).toBe(1);
    expect(widthAwareEraseLines).toBe(4);
  });

  it('returns from an active cursor using physical resize rows', async () => {
    const { default: logUpdate } = await loadCliLogUpdate();
    const stream = createRecordingStream();
    const render = logUpdate.create(stream, { showCursor: true });

    render.setCursorPosition({ x: 1, y: 0 });
    render('x'.repeat(95));
    stream.reset();
    render.clearWidthAware(30);

    expect(stream.output()).toContain('\x1B[3B');
  });

  it('uses the physical cursor row after wrapped lines precede the cursor', async () => {
    const { default: logUpdate } = await loadCliLogUpdate();
    const stream = createRecordingStream();
    const render = logUpdate.create(stream, { showCursor: true });

    render.setCursorPosition({ x: 1, y: 1 });
    render(`${'x'.repeat(95)}\nnext`);
    stream.reset();
    render.clearWidthAware(30);

    expect(countEraseLines(stream.output())).toBe(5);
    expect(stream.output()).not.toContain('\x1B[3B');
  });
});
