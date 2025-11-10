import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import { promises as fs } from 'fs';
import * as vscode from 'vscode';

import * as configModule from '@utils/config';
import { StorageFS, WorkspaceFS } from '@utils/files';
import {
  moveToTarget,
  TASK_RUNS_DIR,
  TaskRunFileService,
} from '@utils/files/taskRunStorage';

suite('taskRunStorage moveToTarget', () => {
  async function createTempDir(prefix: string): Promise<string> {
    return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  }

  async function withPatchedRename(
    code: NodeJS.ErrnoException['code'],
    run: () => Promise<void>,
  ): Promise<void> {
    const originalRename = fs.rename;
    const originalCopyFile = fs.copyFile;
    const originalCp = (fs as any).cp;

    let patched = false;
    try {
      let callCount = 0;
      (fs as unknown as { rename: typeof fs.rename }).rename = async (
        source,
        destination,
      ) => {
        callCount += 1;
        if (callCount === 1) {
          const err = new Error('fail') as NodeJS.ErrnoException;
          err.code = code;
          patched = true;
          throw err;
        }
        return originalRename(source, destination);
      };

      (fs as unknown as { copyFile: typeof fs.copyFile }).copyFile =
        async () => {
          throw new Error('copyFile should not be invoked when retrying move');
        };

      if (originalCp) {
        (fs as any).cp = async () => {
          throw new Error('cp should not be invoked when retrying move');
        };
      }

      await run();
      assert.ok(patched, 'expected rename to be patched for first call');
    } finally {
      (fs as unknown as { rename: typeof fs.rename }).rename = originalRename;
      (fs as unknown as { copyFile: typeof fs.copyFile }).copyFile =
        originalCopyFile;
      if ((fs as any).cp !== undefined) {
        (fs as any).cp = originalCp;
      }
    }
  }

  test('retries directory move when destination exists (EISDIR)', async () => {
    const tmpRoot = await createTempDir('texra-run-');
    const sourceDir = path.join(tmpRoot, 'source');
    const destDir = path.join(tmpRoot, 'dest');

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'file.txt'), 'content');
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, 'old.txt'), 'old');

    await withPatchedRename('EISDIR', async () => {
      await moveToTarget(sourceDir, destDir);
    });

    const destEntries = await fs.readdir(destDir);
    assert.deepEqual(destEntries.sort(), ['file.txt']);

    await assert.rejects(fs.stat(sourceDir));
  });

  test('retries directory move when destination not empty (ENOTEMPTY)', async () => {
    const tmpRoot = await createTempDir('texra-run-');
    const sourceDir = path.join(tmpRoot, 'source2');
    const destDir = path.join(tmpRoot, 'dest2');

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'file.txt'), 'content');
    await fs.mkdir(destDir, { recursive: true });
    await fs.writeFile(path.join(destDir, 'stale.txt'), 'old');

    await withPatchedRename('ENOTEMPTY', async () => {
      await moveToTarget(sourceDir, destDir);
    });

    const destEntries = await fs.readdir(destDir);
    assert.deepEqual(destEntries.sort(), ['file.txt']);

    await assert.rejects(fs.stat(sourceDir));
  });

  test('retries move when destination path includes a blocking file (ENOTDIR)', async () => {
    const tmpRoot = await createTempDir('texra-run-');
    const sourceDir = path.join(tmpRoot, 'source3');
    const destDir = path.join(tmpRoot, 'dest3');

    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, 'file.txt'), 'content');

    await fs.writeFile(destDir, 'stale-file');

    await withPatchedRename('ENOTDIR', async () => {
      await moveToTarget(sourceDir, destDir);
    });

    const destEntries = await fs.readdir(destDir);
    assert.deepEqual(destEntries.sort(), ['file.txt']);

    await assert.rejects(fs.stat(sourceDir));
  });
});

suite('TaskRunFileService prepareRunWorkspace', () => {
  let workspaceRoot: string;
  let storageRoot: string;
  let originalGetConfig: typeof configModule.getConfig;
  let originalWorkspaceFolders: readonly vscode.WorkspaceFolder[] | undefined;
  let originalWorkspaceGetPath: typeof WorkspaceFS.getPath;
  let originalWorkspaceFullPath: typeof WorkspaceFS.fullPath;
  let originalStorageFullPath: typeof StorageFS.fullPath;
  let originalStorageEnsureDir: typeof StorageFS.ensureDir;
  let originalStorageExists: typeof StorageFS.exists;
  let originalStorageCreateDir: typeof StorageFS.createDir;

  setup(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'texra-workspace-'),
    );
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-storage-'));

    originalGetConfig = configModule.getConfig;
    (configModule as { getConfig: typeof originalGetConfig }).getConfig = (<T>(
      key: string,
      defaultValue?: T,
    ) =>
      key === 'texra.agentOutputs.storageMode'
        ? ('taskRunStorage' as T)
        : (defaultValue as T)) as typeof configModule.getConfig;

    originalWorkspaceFolders = vscode.workspace.workspaceFolders;
    (
      vscode.workspace as unknown as {
        workspaceFolders?: vscode.WorkspaceFolder[];
      }
    ).workspaceFolders = [
      {
        uri: vscode.Uri.file(workspaceRoot),
        index: 0,
        name: 'test-workspace',
      },
    ];

    originalWorkspaceGetPath = WorkspaceFS.getPath;
    originalWorkspaceFullPath = WorkspaceFS.fullPath;
    (
      WorkspaceFS as unknown as { getPath: typeof WorkspaceFS.getPath }
    ).getPath = () => workspaceRoot;
    (
      WorkspaceFS as unknown as { fullPath: typeof WorkspaceFS.fullPath }
    ).fullPath = ((target: string) =>
      path.join(workspaceRoot, target)) as typeof WorkspaceFS.fullPath;

    originalStorageFullPath = StorageFS.fullPath;
    originalStorageEnsureDir = StorageFS.ensureDir;
    originalStorageExists = StorageFS.exists;
    originalStorageCreateDir = StorageFS.createDir;
    (StorageFS as unknown as { fullPath: typeof StorageFS.fullPath }).fullPath =
      ((target: string) =>
        path.join(storageRoot, target)) as typeof StorageFS.fullPath;
    (
      StorageFS as unknown as { ensureDir: typeof StorageFS.ensureDir }
    ).ensureDir = (async (target: string) => {
      await fs.mkdir(path.join(storageRoot, target), { recursive: true });
    }) as typeof StorageFS.ensureDir;
    (StorageFS as unknown as { exists: typeof StorageFS.exists }).exists =
      (async (target: string) => {
        try {
          await fs.stat(path.join(storageRoot, target));
          return true;
        } catch {
          return false;
        }
      }) as typeof StorageFS.exists;
    (
      StorageFS as unknown as { createDir: typeof StorageFS.createDir }
    ).createDir = (async (target: string) => {
      await fs.mkdir(path.join(storageRoot, target), { recursive: true });
    }) as typeof StorageFS.createDir;
  });

  teardown(async () => {
    (configModule as { getConfig: typeof originalGetConfig }).getConfig =
      originalGetConfig;
    (
      vscode.workspace as unknown as {
        workspaceFolders?: vscode.WorkspaceFolder[];
      }
    ).workspaceFolders = originalWorkspaceFolders;
    (
      WorkspaceFS as unknown as { getPath: typeof WorkspaceFS.getPath }
    ).getPath = originalWorkspaceGetPath;
    (
      WorkspaceFS as unknown as { fullPath: typeof WorkspaceFS.fullPath }
    ).fullPath = originalWorkspaceFullPath;
    (StorageFS as unknown as { fullPath: typeof StorageFS.fullPath }).fullPath =
      originalStorageFullPath;
    (
      StorageFS as unknown as { ensureDir: typeof StorageFS.ensureDir }
    ).ensureDir = originalStorageEnsureDir;
    (StorageFS as unknown as { exists: typeof StorageFS.exists }).exists =
      originalStorageExists;
    (
      StorageFS as unknown as { createDir: typeof StorageFS.createDir }
    ).createDir = originalStorageCreateDir;

    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  test('captures original base files once per run', async () => {
    const baseRelative = path.join('sections', 'main.tex');
    const basePath = path.join(workspaceRoot, baseRelative);
    await fs.mkdir(path.dirname(basePath), { recursive: true });
    await fs.writeFile(basePath, 'original content');

    const service = new TaskRunFileService('run-1234');
    await service.prepareRunWorkspace([baseRelative]);

    const snapshotPath = path.join(
      storageRoot,
      TASK_RUNS_DIR,
      'run-1234',
      'original',
      baseRelative,
    );
    const snapshotInitial = await fs.readFile(snapshotPath, 'utf-8');
    assert.strictEqual(snapshotInitial, 'original content');

    await fs.writeFile(basePath, 'updated content');
    await service.prepareRunWorkspace([baseRelative]);

    const snapshotAfter = await fs.readFile(snapshotPath, 'utf-8');
    assert.strictEqual(snapshotAfter, 'original content');
  });
});
