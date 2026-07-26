// Node imports
import { readFileSync, readdirSync } from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { describe, expect, it } from 'vitest';

const UI_ROOTS = [
  'packages/desktop/src',
  'packages/extension/src/progressView/frontend',
  'packages/extension/src/settingsView/frontend',
  'packages/extension/src/webview/frontend',
  'src/shared',
] as const;
const SOURCE_EXTENSION = /\.(?:html|js|mjs|ts|tsx)$/;
const DEPRECATED_SIZE = /size="(?:small|medium|large)"/;

function collectSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return collectSourceFiles(entryPath);
    return SOURCE_EXTENSION.test(entry.name) ? [entryPath] : [];
  });
}

describe('Web Awesome size contracts', () => {
  it('uses the current xs/s/m/l/xl size scale throughout shared UI code', () => {
    for (const root of UI_ROOTS) {
      for (const file of collectSourceFiles(path.join(process.cwd(), root))) {
        expect(readFileSync(file, 'utf8'), file).not.toMatch(DEPRECATED_SIZE);
      }
    }
  });
});
