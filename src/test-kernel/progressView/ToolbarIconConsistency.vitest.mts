// Node imports
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Third-party imports
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

function readSource(path: string): string {
  return readFileSync(resolve(REPO_ROOT, path), 'utf8');
}

describe('progress toolbar icon consistency', () => {
  it('uses registered and semantically specific icons for Odyssey and compaction', () => {
    const constants = readSource(
      'packages/extension/src/progressView/frontend/constants.ts',
    );
    const streamHeader = readSource(
      'packages/extension/src/progressView/frontend/components/StreamHeader.ts',
    );
    const iconRegistry = readSource('src/shared/wa/webAwesomeIcons.ts');

    // Compass: Odyssey is no longer a toolbar toggle button — it's a passive
    // header chip surfaced when the agent enters Odyssey mode.
    expect(streamHeader).toContain('name="compass"');
    expect(iconRegistry).toContain('compass: faCompass');

    expect(constants).toContain("icon: 'compress'");
    expect(iconRegistry).toContain('compress: faCompress');
    expect(iconRegistry).toContain("fold: 'compress'");
    expect(iconRegistry).not.toContain("fold: 'chevron-up'");
  });
});
