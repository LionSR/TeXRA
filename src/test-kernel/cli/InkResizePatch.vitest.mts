import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

// The CLI vendors a patch (patches/ink@7.0.5.patch) that rewrites Ink's resize
// handling: instead of erasing the live region by logical line count — which is
// wrong once the emulator reflows soft-wrapped lines at the new width (too few
// rows leaves residue, too many eats the <Static> header) — it repaints from a
// known origin (clearTerminal + reprint fullStaticOutput), debounced so a drag
// collapses into one redraw. The runtime behaviour is verified by hand under a
// real TTY; here we guard that the patch is actually applied to the installed
// ink, so a future ink bump or a dropped patch fails loudly in CI rather than
// silently reverting the resize fix.
function patchedInkSource(): string {
  const cliRequire = createRequire(
    new URL('../../../packages/cli/package.json', import.meta.url),
  );
  const inkBuildDir = path.dirname(cliRequire.resolve('ink'));
  return readFileSync(path.join(inkBuildDir, 'ink.js'), 'utf8');
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

  it('debounces the resize repaint so a drag-storm collapses to one redraw', () => {
    expect(source).toContain('resizeTimer');
    expect(source).toMatch(/setTimeout\(this\.repaintAfterResize/);
  });

  it('no longer references the removed clearWidthAware helper', () => {
    expect(source).not.toContain('clearWidthAware');
  });
});
