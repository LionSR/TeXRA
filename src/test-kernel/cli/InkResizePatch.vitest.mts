import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

type LogUpdateRenderer = ((value: string) => boolean) & {
  reset: () => void;
};

// The CLI vendors a patch (patches/ink@7.0.5.patch) that rewrites Ink's resize
// handling: instead of erasing the live region by logical line count — which is
// wrong once the emulator reflows soft-wrapped lines at the new width (too few
// rows leaves residue, too many eats the <Static> header) — it repaints from a
// known origin (clearTerminal + reprint fullStaticOutput), debounced so a drag
// collapses into one redraw. The runtime behaviour is verified by hand under a
// real TTY; here we guard that the patch is actually applied to the installed
// ink, so a future ink bump or a dropped patch fails loudly in CI rather than
// silently reverting the resize fix.
function inkBuildDir(): string {
  const cliRequire = createRequire(
    new URL('../../../packages/cli/package.json', import.meta.url),
  );
  return path.dirname(cliRequire.resolve('ink'));
}

function patchedInkSource(): string {
  return readFileSync(path.join(inkBuildDir(), 'ink.js'), 'utf8');
}

async function createLogUpdateRenderer(
  incremental: boolean,
): Promise<LogUpdateRenderer> {
  const moduleUrl = pathToFileURL(
    path.join(inkBuildDir(), 'log-update.js'),
  ).href;
  const { default: logUpdate } = await import(moduleUrl);
  const output = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  return logUpdate.create(output, { incremental }) as LogUpdateRenderer;
}

describe('CLI Ink resize patch', () => {
  const source = patchedInkSource();

  it('repaints from a known origin on resize instead of line-count erasing', () => {
    expect(source).toContain('repaintAfterResize');
    expect(source).toContain(
      'ansiEscapes.clearTerminal + this.fullStaticOutput',
    );
    // Resets log-update's internal cursor/line bookkeeping before the repaint.
    expect(source).toContain('this.log.reset()');
  });

  it('calls a real log-update reset method for both renderer variants', async () => {
    for (const incremental of [false, true]) {
      const render = await createLogUpdateRenderer(incremental);

      expect(typeof render.reset).toBe('function');
      render('hello');
      expect(() => render.reset()).not.toThrow();
    }
  });

  it('debounces the resize repaint so a drag-storm collapses to one redraw', () => {
    expect(source).toContain('resizeTimer');
    expect(source).toMatch(/setTimeout\(this\.repaintAfterResize/);
  });

  it('no longer references the removed clearWidthAware helper', () => {
    expect(source).not.toContain('clearWidthAware');
  });
});
