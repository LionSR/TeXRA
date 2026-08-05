import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

type LogUpdateRenderer = ((value: string) => boolean) & {
  reset: () => void;
};

const cliRequire = createRequire(
  new URL('../../../packages/cli/package.json', import.meta.url),
);

// The CLI vendors a patch (patches/ink@7.1.1.patch) that rewrites Ink's resize
// handling: instead of erasing the live region by logical line count — which is
// wrong once the emulator reflows soft-wrapped lines at the new width (too few
// rows leaves residue, too many eats the <Static> header) — it repaints from a
// known origin via the patched repaint primitive, debounced so a drag collapses
// into one redraw. The runtime behaviour is verified by hand under a real TTY;
// here we guard that the patch is actually applied to the installed ink, so a
// future ink bump or a dropped patch fails loudly in CI rather than silently
// reverting the resize fix.
function inkBuildDir(): string {
  return path.dirname(cliRequire.resolve('ink'));
}

function inkRequire(): NodeJS.Require {
  return createRequire(path.join(inkBuildDir(), 'ink.js'));
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
    expect(source).toContain('this.repaint({ clearScrollback: true });');
    expect(source).toContain(
      'const clearSequence = options.clearScrollback === true',
    );
    expect(source).toContain('ansiEscapes.clearTerminal');
    expect(source).toContain('ansiEscapes.clearViewport');
    // Resets log-update's internal cursor/line bookkeeping before the repaint.
    expect(source).toContain('this.log.reset()');
  });

  it('wraps full repaint writes in synchronized output when supported', () => {
    const repaint = source.indexOf('repaint(options = {})');
    const logReset = source.indexOf('this.log.reset()', repaint);
    const shouldSync = source.indexOf(
      'const sync = this.shouldSync();',
      logReset,
    );
    const beginSync = source.indexOf(
      'this.options.stdout.write(bsu);',
      shouldSync,
    );
    const writeFrame = source.indexOf(
      'this.options.stdout.write(clearSequence + previousStaticOutput + nextStaticOutput + outputToRender);',
      beginSync,
    );
    const endSync = source.indexOf(
      'this.options.stdout.write(esu);',
      writeFrame,
    );
    const logSync = source.indexOf('this.log.sync(outputToRender);', endSync);

    expect(repaint).toBeGreaterThanOrEqual(0);
    expect(logReset).toBeGreaterThanOrEqual(0);
    expect(shouldSync).toBeGreaterThan(logReset);
    expect(beginSync).toBeGreaterThan(shouldSync);
    expect(writeFrame).toBeGreaterThan(beginSync);
    expect(endSync).toBeGreaterThan(writeFrame);
    expect(logSync).toBeGreaterThan(endSync);
  });

  it('calls a real log-update reset method for both renderer variants', async () => {
    for (const incremental of [false, true]) {
      const render = await createLogUpdateRenderer(incremental);

      expect(typeof render.reset).toBe('function');
      render('hello');
      expect(() => render.reset()).not.toThrow();
    }
  });

  it('uses the installed ansi-escapes clearViewport sequence', () => {
    const ansiEscapes = inkRequire()('ansi-escapes') as {
      readonly clearViewport?: unknown;
    };

    expect(typeof ansiEscapes.clearViewport).toBe('string');
    expect(ansiEscapes.clearViewport).toBe('\u001B[2J\u001B[H');
  });

  it('debounces the resize repaint so a drag-storm collapses to one redraw', () => {
    expect(source).toContain('resizeTimer');
    expect(source).toMatch(/setTimeout\(this\.repaintAfterResize/);
  });

  it('updates layout synchronously before scheduling the repaint', () => {
    const resizeStart = source.indexOf('resized = () => {');
    const scheduleRepaint = source.indexOf(
      'setTimeout(this.repaintAfterResize',
      resizeStart,
    );
    const calculateLayout = source.indexOf(
      'this.calculateLayout();',
      resizeStart,
    );
    const emitLayout = source.indexOf(
      'dom.emitLayoutListeners(this.rootNode);',
      resizeStart,
    );

    expect(resizeStart).toBeGreaterThanOrEqual(0);
    expect(calculateLayout).toBeGreaterThan(resizeStart);
    expect(emitLayout).toBeGreaterThan(calculateLayout);
    expect(scheduleRepaint).toBeGreaterThan(emitLayout);
  });

  it('no longer references the removed clearWidthAware helper', () => {
    expect(source).not.toContain('clearWidthAware');
  });
});
