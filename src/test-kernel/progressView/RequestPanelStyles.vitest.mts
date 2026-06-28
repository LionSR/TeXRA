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
    const hostStart = source.indexOf(':host {');
    const containersStart = source.indexOf(':is(${CONTAINERS}) {');
    const hostRule = source.slice(hostStart, containersStart);
    const actionStart = source.indexOf(
      '.approval-request__actions wa-button[data-action] {',
    );
    const boundedChildrenStart = source.indexOf(':is(${ACTIONS}) > * {');
    const primaryActionsStart = source.indexOf(
      ':is(${ACTIONS}) .action-button {',
    );
    const baseStart = source.indexOf(
      '.approval-request__actions wa-button[data-action]::part(base)',
    );
    const labelStart = source.indexOf(
      '.approval-request__actions wa-button[data-action]::part(label)',
    );
    const colorsStart = source.indexOf('/* Shared action button colors */');
    const actionRule = source.slice(actionStart, baseStart);
    const baseRule = source.slice(baseStart, source.indexOf('}', baseStart));
    const boundedChildrenRule = source.slice(
      boundedChildrenStart,
      primaryActionsStart,
    );
    const labelRule = source.slice(labelStart, colorsStart);

    expect(hostStart).toBeGreaterThanOrEqual(0);
    expect(containersStart).toBeGreaterThan(hostStart);
    expect(hostRule).toContain('min-width: 0');
    expect(hostRule).toContain('max-width: 100%');
    expect(boundedChildrenStart).toBeGreaterThanOrEqual(0);
    expect(primaryActionsStart).toBeGreaterThan(boundedChildrenStart);
    expect(boundedChildrenRule).toContain('min-width: 0');
    expect(boundedChildrenRule).toContain('max-width: 100%');
    expect(actionStart).toBeGreaterThanOrEqual(0);
    expect(baseStart).toBeGreaterThan(actionStart);
    expect(actionRule).toContain('flex: 0 1 7rem');
    expect(actionRule).toContain('min-width: min(5.5rem, 100%)');
    expect(actionRule).toContain('max-width: min(7rem, 100%)');
    expect(baseRule).toContain('justify-content: center');
    expect(baseRule).toContain('width: 100%');
    expect(baseRule).toContain('inline-size: 100%');
    expect(baseRule).toContain('max-width: 100%');
    expect(labelStart).toBeGreaterThan(baseStart);
    expect(colorsStart).toBeGreaterThan(labelStart);
    expect(labelRule).toContain('overflow: hidden');
    expect(labelRule).toContain('text-overflow: ellipsis');
    expect(labelRule).toContain('white-space: nowrap');
  });

  it('keeps the tool edit diff dropdown capped inside approval panels', () => {
    const source = readRequestPanelStyles();
    const dropdownStart = source.indexOf(
      '.approval-request__actions .diff-dropdown {',
    );
    const dropdownButtonStart = source.indexOf(
      '.approval-request__actions .diff-dropdown .diff-main-button {',
    );
    const dropdownRule = source.slice(dropdownStart, dropdownButtonStart);
    const dropdownButtonRule = source.slice(
      dropdownButtonStart,
      source.indexOf('}', dropdownButtonStart),
    );

    expect(dropdownStart).toBeGreaterThanOrEqual(0);
    expect(dropdownButtonStart).toBeGreaterThan(dropdownStart);
    expect(dropdownRule).toContain('flex: 1 1 7rem');
    expect(dropdownRule).toContain('min-width: 0');
    expect(dropdownRule).toContain('max-width: min(8.25rem, 100%)');
    expect(dropdownRule).not.toContain('max-inline-size: 100%');
    expect(dropdownButtonRule).toContain('flex: 1 1 auto');
    expect(dropdownButtonRule).toContain('width: auto');
    expect(dropdownButtonRule).toContain('min-width: 0');
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
