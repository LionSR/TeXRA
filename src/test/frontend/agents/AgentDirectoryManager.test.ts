import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import * as vscode from 'vscode';

import { agentDirectories } from '@frontend/agents/AgentDirectoryManager';
import StorageFS from '@utils/files/storageFS';

suite('AgentDirectoryManager', () => {
  let tempDir: string;

  function createContext(basePath: string): vscode.ExtensionContext {
    const uri = vscode.Uri.file(basePath);
    return {
      globalStorageUri: uri,
      storageUri: uri,
    } as unknown as vscode.ExtensionContext;
  }

  setup(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-dirs-'));
    const context = createContext(tempDir);
    StorageFS.initialize(context);
    agentDirectories.initialize(context);
  });

  teardown(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  test('getDirectoryMap returns consistent directory paths', async () => {
    const map = await agentDirectories.getDirectoryMap();
    const [builtIn, builtInToolUse, custom] = await Promise.all([
      agentDirectories.builtIn(),
      agentDirectories.builtInToolUse(),
      agentDirectories.custom(),
    ]);

    assert.strictEqual(map.builtIn, builtIn);
    assert.strictEqual(map.builtInToolUse, builtInToolUse);
    assert.strictEqual(map.custom, custom);
  });
});
