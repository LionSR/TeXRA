// Node imports
import { readFileSync } from 'node:fs';

// Third-party imports
import { describe, expect, it } from 'vitest';

// Local imports - test paths
import { repoPath } from '../desktop/desktopTestPaths.mjs';

function readFileSelectGroup(): string {
  return readFileSync(
    repoPath(
      'packages/extension/src/webview/frontend/components/FileSelectGroup.ts',
    ),
    'utf8',
  );
}

function readInstructionPanel(): string {
  return readFileSync(
    repoPath(
      'packages/extension/src/webview/frontend/components/InstructionPanel.ts',
    ),
    'utf8',
  );
}

function readMainApp(): string {
  return readFileSync(
    repoPath('packages/extension/src/webview/frontend/MainApp.ts'),
    'utf8',
  );
}

/**
 * Extract the body of the `private handleDrop(...)` method from a component
 * source so we can assert on its statement ordering.
 */
function extractHandleDropBody(source: string): string {
  const start = source.indexOf('private handleDrop(');
  expect(start, 'handleDrop method should exist').toBeGreaterThan(-1);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(braceStart + 1, i);
    }
  }
  throw new Error('Unbalanced braces in handleDrop');
}

function readFileSelectStyles(): string {
  return readFileSync(
    repoPath(
      'packages/extension/src/webview/frontend/styles/fileSelectStyles.ts',
    ),
    'utf8',
  );
}

describe('file select groups', () => {
  it('always renders the file list instead of hiding it behind a toggle', () => {
    const component = readFileSelectGroup();
    const mainApp = readMainApp();
    const styles = readFileSelectStyles();

    expect(component).toContain('class="multiple-files-container"');
    expect(component).not.toContain('handleToggleList');
    expect(component).not.toContain('config.toggleTitle');
    expect(component).not.toContain('waIcon(chevronName)');
    expect(component).not.toContain('data-expanded=');
    expect(mainApp).not.toContain('@toggle-list=');
    expect(styles).not.toContain('.file-select[data-expanded');
  });
});

describe('drop-target drag-active reset', () => {
  // A non-file URI (e.g. an https link) carries `text/uri-list`, so during the
  // protected-mode dragenter/dragover the bucket optimistically activates the
  // drop-active outline. At drop time the payload is readable and rejected by
  // `hasDroppedFilePayload`, and no `dragleave` fires after a `drop` — so the
  // reset MUST run before the rejection early-return, or the outline sticks
  // forever. Guard both drop targets against regressing into the old ordering
  // where the reset lived after the `hasDroppedFilePayload` guard.
  for (const [name, read] of [
    ['FileSelectGroup', readFileSelectGroup],
    ['InstructionPanel', readInstructionPanel],
  ] as const) {
    it(`${name} resets drag state before the rejection early-return`, () => {
      const body = extractHandleDropBody(read());

      const resetDepthAt = body.indexOf('this.dragDepth = 0;');
      const resetActiveAt = body.indexOf('this.isDragActive = false;');
      const guardReturnAt = body.indexOf('if (!hasDroppedFilePayload(');

      expect(resetDepthAt, 'resets dragDepth').toBeGreaterThan(-1);
      expect(resetActiveAt, 'resets isDragActive').toBeGreaterThan(-1);
      expect(guardReturnAt, 'guards on hasDroppedFilePayload').toBeGreaterThan(
        -1,
      );

      // Both resets run before the payload guard, so a rejected drop still
      // clears the drop-active visuals.
      expect(resetDepthAt).toBeLessThan(guardReturnAt);
      expect(resetActiveAt).toBeLessThan(guardReturnAt);
    });
  }
});
