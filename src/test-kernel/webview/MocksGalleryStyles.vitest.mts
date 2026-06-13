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

function readSource(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

describe('mock gallery styles', () => {
  it('keeps mock previews inside the launcher panel', () => {
    const source = readSource(
      'packages/extension/src/webview/frontend/mocks/MocksGallery.ts',
    );
    const hostStart = source.indexOf(':host {');
    const sectionStart = source.indexOf('.section {');
    const sectionChildrenStart = source.indexOf('.section > * {');
    const customElementStart = source.indexOf('texra-todo-list-mock,');
    const headerStart = source.indexOf('.header-strip {');
    const labelStart = source.indexOf('.header-strip__label {');
    const hostRule = source.slice(hostStart, sectionStart);
    const sectionRule = source.slice(sectionStart, sectionChildrenStart);
    const customElementRule = source.slice(
      customElementStart,
      source.indexOf('}', customElementStart),
    );
    const headerRule = source.slice(headerStart, labelStart);
    const labelRule = source.slice(labelStart, source.indexOf('}', labelStart));

    expect(hostStart).toBeGreaterThanOrEqual(0);
    expect(sectionChildrenStart).toBeGreaterThan(sectionStart);
    expect(customElementStart).toBeGreaterThan(sectionChildrenStart);
    expect(headerStart).toBeGreaterThan(hostStart);
    expect(labelStart).toBeGreaterThan(headerStart);
    expect(hostRule).toContain('min-width: 0');
    expect(hostRule).toContain('max-width: 100%');
    expect(hostRule).toContain('overflow-x: hidden');
    expect(sectionRule).toContain('min-width: 0');
    expect(sectionRule).toContain('max-width: 100%');
    expect(sectionRule).toContain('overflow-x: hidden');
    expect(customElementRule).toContain('display: block');
    expect(customElementRule).toContain('min-width: 0');
    expect(customElementRule).toContain('max-width: 100%');
    expect(customElementRule).toContain('overflow-x: hidden');
    expect(headerRule).toContain('flex-wrap: wrap');
    expect(headerRule).toContain('min-width: 0');
    expect(headerRule).toContain('max-width: 100%');
    expect(labelRule).toContain('min-width: 0');
    expect(labelRule).toContain('text-overflow: ellipsis');
  });

  it('clips progress-board mock internals at the preview boundary', () => {
    const source = readSource(
      'packages/extension/src/webview/frontend/mocks/ProgressBoardLayoutMock.ts',
    );
    const hostStart = source.indexOf(':host {');
    const boardStart = source.indexOf('.board {');
    const conversationStart = source.indexOf('.conversation {');
    const conversationMediaStart = source.indexOf(
      '@media (max-width: 720px)',
      conversationStart,
    );
    const logStart = source.indexOf('.log-body {');
    const taskGroupStart = source.indexOf('task-group-list {');
    const streamTabsStart = source.indexOf('stream-tabs {');
    const filesBlockStart = source.indexOf('.files-block {');
    const hostRule = source.slice(hostStart, boardStart);
    const conversationRule = source.slice(
      conversationStart,
      conversationMediaStart,
    );
    const logRule = source.slice(logStart, taskGroupStart);
    const streamTabsRule = source.slice(streamTabsStart, filesBlockStart);

    expect(hostStart).toBeGreaterThanOrEqual(0);
    expect(conversationStart).toBeGreaterThan(boardStart);
    expect(logStart).toBeGreaterThan(conversationStart);
    expect(streamTabsStart).toBeGreaterThan(taskGroupStart);
    expect(filesBlockStart).toBeGreaterThan(streamTabsStart);
    expect(hostRule).toContain('min-width: 0');
    expect(hostRule).toContain('max-width: 100%');
    expect(hostRule).toContain('overflow-x: hidden');
    expect(conversationRule).toContain('min-width: 0');
    expect(conversationRule).toContain('max-width: 100%');
    expect(conversationRule).toContain('overflow: hidden');
    expect(logRule).toContain('min-width: 0');
    expect(logRule).toContain('overflow: hidden');
    expect(streamTabsRule).toContain('min-width: 0');
    expect(streamTabsRule).toContain('max-width: 100%');
    expect(streamTabsRule).toContain('overflow: hidden');
  });
});
