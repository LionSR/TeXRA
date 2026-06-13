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

function readStreamTabsStyles(): string {
  return readFileSync(
    resolve(
      REPO_ROOT,
      'packages/extension/src/progressView/frontend/components/streamTabsStyles.ts',
    ),
    'utf8',
  );
}

describe('stream tabs styles', () => {
  it('contains narrow rails at every flex boundary', () => {
    const source = readStreamTabsStyles();
    const tabHostStart = source.indexOf(':host {');
    const tabContainerStart = source.indexOf('.tab-container {');
    const tabStart = source.indexOf('.tab {');
    const tabHeaderStart = source.indexOf('.tab-header {');
    const tabTitleStart = source.indexOf('.tab-title {');
    const tabMetaStart = source.indexOf('.tab-meta {');
    const containerHostStart = source.indexOf(
      'export const streamTabsContainerStyles',
    );
    const tabsStart = source.indexOf('.tabs {', containerHostStart);
    const tabsContentStart = source.indexOf('.tabs-content {');
    const tabsContentChildrenStart = source.indexOf('.tabs-content > div {');
    const childStreamsStart = source.indexOf('.child-streams {');

    const tabHostRule = source.slice(tabHostStart, tabContainerStart);
    const tabContainerRule = source.slice(tabContainerStart, tabStart);
    const tabHeaderRule = source.slice(tabHeaderStart, tabTitleStart);
    const tabTitleRule = source.slice(tabTitleStart, tabMetaStart);
    const tabMetaRule = source.slice(
      tabMetaStart,
      source.indexOf('.tab-meta .remote-agent,', tabMetaStart),
    );
    const containerHostRule = source.slice(
      source.indexOf(':host {', containerHostStart),
      source.indexOf(':host([hidden])', containerHostStart),
    );
    const tabsRule = source.slice(
      tabsStart,
      source.indexOf('.stream-tabs-header {'),
    );
    const tabsContentRule = source.slice(
      tabsContentStart,
      tabsContentChildrenStart,
    );
    const tabsContentChildrenRule = source.slice(
      tabsContentChildrenStart,
      source.indexOf('}', tabsContentChildrenStart),
    );
    const childStreamsRule = source.slice(
      childStreamsStart,
      source.indexOf('}', childStreamsStart),
    );

    expect(tabHostRule).toContain('min-width: 0');
    expect(tabHostRule).toContain('max-width: 100%');
    expect(tabHostRule).toContain('overflow: hidden');
    expect(tabContainerRule).toContain('min-width: 0');
    expect(tabContainerRule).toContain('max-width: 100%');
    expect(tabContainerRule).toContain('overflow: hidden');
    expect(tabHeaderRule).toContain('min-width: 0');
    expect(tabTitleRule).toContain('min-width: 0');
    expect(tabMetaRule).toContain('min-width: 0');
    expect(tabMetaRule).toContain('overflow: hidden');
    expect(containerHostRule).toContain('min-width: 0');
    expect(containerHostRule).toContain('max-width: 100%');
    expect(containerHostRule).toContain('overflow: hidden');
    expect(tabsRule).toContain('overflow: hidden');
    expect(tabsContentRule).toContain('overflow-x: hidden');
    expect(tabsContentChildrenRule).toContain('min-width: 0');
    expect(tabsContentChildrenRule).toContain('max-width: 100%');
    expect(tabsContentChildrenRule).toContain('overflow-x: hidden');
    expect(childStreamsRule).toContain('min-width: 0');
    expect(childStreamsRule).toContain('max-width: 100%');
    expect(childStreamsRule).toContain('overflow: hidden');
  });
});
