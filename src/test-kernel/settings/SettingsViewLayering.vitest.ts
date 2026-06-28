import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);

function readSource(relativePath: string): string {
  return readFileSync(resolve(REPO_ROOT, relativePath), 'utf8');
}

function importSources(source: string): string[] {
  return [...source.matchAll(/from\s+['"]([^'"]+)['"]/g)].map(
    (match) => match[1] ?? '',
  );
}

describe('settings view layering', () => {
  it('keeps goal-list runtime projection out of the settings message dispatcher', () => {
    expect(
      importSources(
        readSource(
          'packages/extension/src/settingsView/SettingsViewMessageHandler.ts',
        ),
      ),
    ).not.toContain('@agent/runtime/goalCommands');
  });

  it('keeps runtime agent resolution out of the extension agent handler', () => {
    expect(
      importSources(
        readSource(
          'packages/extension/src/settingsView/handlers/agentHandlers.ts',
        ),
      ),
    ).not.toContain('@agent/runtime/agentResolution');
  });

  it('keeps runtime history actions out of the extension history handler', () => {
    const imports = importSources(
      readSource(
        'packages/extension/src/settingsView/handlers/historyHandlers.ts',
      ),
    );

    expect(imports).not.toContain('@agent/runtime/historyCommands');
    expect(imports).not.toContain('@agent/runtime/executionRequests');
  });

  it('keeps runtime history actions out of desktop settings IPC', () => {
    expect(
      importSources(
        readSource('packages/desktop/src/main/desktopSettingsIpc.ts'),
      ),
    ).not.toContain('@agent/runtime/historyCommands');
  });
});
