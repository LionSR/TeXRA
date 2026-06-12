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

function readRequestPanelStyles(): string {
  return readFileSync(
    resolve(REPO_ROOT, 'src/shared/styles/requestPanelStyles.ts'),
    'utf8',
  );
}

describe('request panel styles', () => {
  it('keeps tool edit approval actions compact', () => {
    const source = readRequestPanelStyles();
    const actionStart = source.indexOf(
      '.approval-request__actions wa-button[data-action] {',
    );
    const baseStart = source.indexOf(
      '.approval-request__actions wa-button[data-action]::part(base)',
    );
    const actionRule = source.slice(actionStart, baseStart);
    const baseRule = source.slice(baseStart, source.indexOf('}', baseStart));

    expect(actionStart).toBeGreaterThanOrEqual(0);
    expect(baseStart).toBeGreaterThan(actionStart);
    expect(actionRule).toContain('flex: 0 1 6.5rem');
    expect(actionRule).toContain('width: 6.5rem');
    expect(actionRule).toContain('max-width: 100%');
    expect(baseRule).toContain('justify-content: center');
    expect(baseRule).toContain('width: 100%');
  });

  it('keeps retry error details headers compact', () => {
    const source = readRequestPanelStyles();
    const headerStart = source.indexOf(
      '.retry-request__error-details::part(header)',
    );
    const contentStart = source.indexOf(
      '.retry-request__error-details::part(content)',
    );
    const headerRule = source.slice(headerStart, contentStart);

    expect(headerStart).toBeGreaterThanOrEqual(0);
    expect(contentStart).toBeGreaterThan(headerStart);
    expect(headerRule).toContain('min-height: 28px');
    expect(headerRule).toContain('padding: ${sp.small} ${sp.large}');
  });
});
