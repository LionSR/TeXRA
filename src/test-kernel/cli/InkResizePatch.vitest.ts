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

/**
 * Asserts each token occurs in `source` strictly after the previous one, so a
 * patch hunks reordering fails loudly instead of passing on stale anchors.
 */
function expectInOrder(source: string, tokens: readonly string[]): void {
  let cursor = 0;
  for (const token of tokens) {
    const index = source.indexOf(token, cursor);
    expect(
      index,
      `missing or out-of-order token: ${token}`,
    ).toBeGreaterThanOrEqual(0);
    cursor = index;
  }
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
});
