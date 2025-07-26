import * as assert from 'assert';
import * as path from 'path';
import * as vscode from 'vscode';
import * as os from 'os';

import {
  StorageFS,
  TASK_RUNS_DIR,
  ensureRunDir,
  getRunDir,
} from '../utils/files';

suite('taskRunStorage', () => {
  const tmpBase = path.join(os.tmpdir(), `texra-${Date.now()}`);
  const context = {
    storageUri: vscode.Uri.file(tmpBase),
    globalStorageUri: vscode.Uri.file(tmpBase),
  } as unknown as vscode.ExtensionContext;

  suiteSetup(() => {
    StorageFS.initialize(context);
  });

  test('ensureRunDir creates directory', async () => {
    const id = `run-${Date.now()}`;
    await ensureRunDir(id);
    const exists = await StorageFS.exists(path.join(TASK_RUNS_DIR, id));
    assert.strictEqual(exists, true);
    assert.strictEqual(getRunDir(id), path.join(tmpBase, TASK_RUNS_DIR, id));

    await StorageFS.delete(path.join(TASK_RUNS_DIR, id), { recursive: true });
  });
});
