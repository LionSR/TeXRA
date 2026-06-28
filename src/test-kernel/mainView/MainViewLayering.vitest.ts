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

describe('main view layering', () => {
  it('keeps runtime category lookup out of remote agent selection UI', () => {
    expect(
      readSource('packages/extension/src/frontend/agents/remoteAgentUtils.ts'),
    ).not.toContain('@agent/runtime/agentResolution');
  });

  it('keeps setup-agent selection projection out of MainViewProvider', () => {
    expect(
      readSource('packages/extension/src/MainViewProvider.ts'),
    ).not.toContain('getRuntimeToolUseAgent');
  });

  it('keeps agent key resolution inside the selection controller', () => {
    const restoreController = readSource(
      'src/controllers/mainView/MainViewStateRestoreController.ts',
    );
    const selectionController = readSource(
      'src/controllers/mainView/MainViewAgentSelectionController.ts',
    );
    const agentResolution = readSource('src/agent/runtime/agentResolution.ts');

    expect(restoreController).not.toContain('resolveRuntimeAgentKey');
    expect(restoreController).toContain('MainViewAgentSelectionController');
    expect(selectionController).not.toContain('resolveRuntimeAgentKey');
    expect(agentResolution).not.toContain('resolveRuntimeAgentKey');
  });

  it('keeps option-refresh message construction in the startup controller', () => {
    const provider = readSource('packages/extension/src/MainViewProvider.ts');
    const commands = readSource(
      'packages/extension/src/commands/system/mainViewCommands.ts',
    );
    const handler = readSource(
      'packages/extension/src/webview/MainViewMessageHandler.ts',
    );
    const extensionStartup = readSource(
      'packages/extension/src/frontend/agents/mainViewStartup.ts',
    );
    const startupFactory = readSource(
      'src/controllers/mainView/MainViewStartupControllerFactory.ts',
    );

    for (const source of [provider, commands, extensionStartup]) {
      expect(source).not.toContain('computeRuntimeAgentOptionsData');
      expect(source).not.toContain('computeModelOptionsData');
      expect(source).not.toContain('SET_MODEL_OPTIONS');
      expect(source).not.toContain('SET_AGENT_OPTIONS');
    }
    expect(handler).toContain('createExtensionMainViewStartupController');
    expect(handler).not.toContain('new MainViewStartupController');
    expect(startupFactory).toContain('computeRuntimeAgentOptionsData');
    expect(startupFactory).toContain('computeModelOptionsData');
  });
});
