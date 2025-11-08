import { strict as assert } from 'assert';
import * as path from 'path';

import {
  TaskRunFileService,
  TASK_RUNS_DIR,
  StorageFS,
  WorkspaceFS,
  AbsoluteFS,
  extractExecutionIdFromPath,
} from '@utils/files';
import { LaTeXdiffService } from '@latex/latexdiff';

suite('taskRunStorage utilities', () => {
  type StorageFsMutable = {
    ensureDir: typeof StorageFS.ensureDir;
    fullPath: typeof StorageFS.fullPath;
  };

  type WorkspaceFsMutable = {
    relativePath: typeof WorkspaceFS.relativePath;
    getPath: typeof WorkspaceFS.getPath;
    fullPath: typeof WorkspaceFS.fullPath;
    exists: typeof WorkspaceFS.exists;
    read: typeof WorkspaceFS.read;
    write: typeof WorkspaceFS.write;
  };

  type AbsoluteFsMutable = {
    ensureDir: typeof AbsoluteFS.ensureDir;
    delete: typeof AbsoluteFS.delete;
    symlink: typeof AbsoluteFS.symlink;
    exists: typeof AbsoluteFS.exists;
  };

  const storageFs = StorageFS as unknown as StorageFsMutable;
  const workspaceFs = WorkspaceFS as unknown as WorkspaceFsMutable;
  const absoluteFs = AbsoluteFS as unknown as AbsoluteFsMutable;

  const originalStorageEnsureDir = storageFs.ensureDir;
  const originalStorageFullPath = storageFs.fullPath;
  const originalWorkspaceRelativePath = workspaceFs.relativePath;
  const originalWorkspaceGetPath = workspaceFs.getPath;
  const originalWorkspaceFullPath = workspaceFs.fullPath;
  const originalWorkspaceExists = workspaceFs.exists;
  const originalWorkspaceRead = workspaceFs.read;
  const originalWorkspaceWrite = workspaceFs.write;
  const originalAbsoluteEnsureDir = absoluteFs.ensureDir;
  const originalAbsoluteDelete = absoluteFs.delete;
  const originalAbsoluteSymlink = absoluteFs.symlink;
  const originalAbsoluteExists = absoluteFs.exists;

  suite('TaskRunFileService', () => {
    let ensuredStorage: string[];
    let ensuredAbsolute: string[];
    let symlinks: Array<{ target: string; link: string }>;
    const executionId = 'run-001';

    beforeEach(() => {
      ensuredStorage = [];
      ensuredAbsolute = [];
      symlinks = [];

      storageFs.ensureDir = async (relative) => {
        ensuredStorage.push(relative);
      };

      storageFs.fullPath = (relative) => path.join('/mock/storage', relative);

      workspaceFs.relativePath = (filePath) =>
        filePath.replace('/mock/workspace/', '');
      workspaceFs.getPath = () => '/mock/workspace';
      workspaceFs.fullPath = (relative) =>
        path.join('/mock/workspace', relative);

      absoluteFs.ensureDir = async (dir) => {
        ensuredAbsolute.push(dir);
      };
      absoluteFs.delete = async (_target) => {
        // no-op for tests
      };
      absoluteFs.symlink = async (target, link) => {
        symlinks.push({ target, link });
      };
      absoluteFs.exists = async () => false;
    });

    afterEach(() => {
      storageFs.ensureDir = originalStorageEnsureDir;
      storageFs.fullPath = originalStorageFullPath;
      workspaceFs.relativePath = originalWorkspaceRelativePath;
      workspaceFs.getPath = originalWorkspaceGetPath;
      workspaceFs.fullPath = originalWorkspaceFullPath;
      absoluteFs.ensureDir = originalAbsoluteEnsureDir;
      absoluteFs.delete = originalAbsoluteDelete;
      absoluteFs.symlink = originalAbsoluteSymlink;
      absoluteFs.exists = originalAbsoluteExists;
    });

    test('maps workspace files into the run directory structure', () => {
      const service = new TaskRunFileService(executionId as any);
      const storagePath = service.getStoragePathForWorkspaceFile(
        '/mock/workspace/docs/chapter.tex',
      );

      assert.strictEqual(
        storagePath,
        path.join(
          '/mock/storage',
          TASK_RUNS_DIR,
          executionId,
          'docs',
          'chapter.tex',
        ),
      );
    });

    test('ensures run directories for mirrored files', async () => {
      const service = new TaskRunFileService(executionId as any);
      await service.ensureDirForWorkspaceFile('/mock/workspace/docs/main.tex');

      assert.deepStrictEqual(ensuredStorage, [
        TASK_RUNS_DIR,
        path.join(TASK_RUNS_DIR, executionId),
        path.join(TASK_RUNS_DIR, executionId, 'docs'),
      ]);
    });

    test('creates symlinks inside the run directory', async () => {
      const service = new TaskRunFileService(executionId as any);
      const mirror = await service.ensureWorkspaceSymlink(
        '/mock/workspace/docs/main.tex',
      );

      assert.strictEqual(
        mirror,
        path.join(
          '/mock/storage',
          TASK_RUNS_DIR,
          executionId,
          'docs',
          'main.tex',
        ),
      );
      assert.deepStrictEqual(ensuredAbsolute, [path.dirname(mirror)]);
      assert.deepStrictEqual(symlinks, [
        { target: '/mock/workspace/docs/main.tex', link: mirror },
      ]);
    });

    test('maps storage paths back to the workspace tree', () => {
      const service = new TaskRunFileService(executionId as any);
      const workspacePath = service.getWorkspacePathFromStorage(
        path.join(
          '/mock/storage',
          TASK_RUNS_DIR,
          executionId,
          'docs',
          'output.tex',
        ),
      );

      assert.strictEqual(
        workspacePath,
        path.join('/mock/workspace', 'docs', 'output.tex'),
      );
    });
  });

  suite('extractExecutionIdFromPath', () => {
    test('returns execution id when present in the path', () => {
      const id = extractExecutionIdFromPath(
        path.join('/tmp', TASK_RUNS_DIR, 'abc-123', 'file.tex'),
      );
      assert.strictEqual(id, 'abc-123');
    });

    test('returns undefined when the path does not include the run directory', () => {
      const id = extractExecutionIdFromPath('/tmp/workspace/file.tex');
      assert.strictEqual(id, undefined);
    });
  });

  suite('LaTeXdiffService runDiff', () => {
    let writes: Array<{ path: string; content: string | Uint8Array }>;
    let ensuredStorage: string[];
    let ensuredAbsolute: string[];
    let symlinks: Array<{ target: string; link: string }>;
    let capturedCwd: string | undefined;

    beforeEach(() => {
      writes = [];
      ensuredStorage = [];
      ensuredAbsolute = [];
      symlinks = [];
      capturedCwd = undefined;

      storageFs.ensureDir = async (relative) => {
        ensuredStorage.push(relative);
      };
      storageFs.fullPath = (relative) => path.join('/mock/storage', relative);

      workspaceFs.relativePath = (filePath) =>
        filePath.replace('/mock/workspace/', '');
      workspaceFs.getPath = () => '/mock/workspace';
      workspaceFs.fullPath = (relative) =>
        path.join('/mock/workspace', relative);
      workspaceFs.exists = async () => true;
      workspaceFs.read = async () => '\\begin{document}Content\\end{document}';
      workspaceFs.write = async (filePath, content) => {
        writes.push({ path: filePath, content });
      };

      absoluteFs.ensureDir = async (dir) => {
        ensuredAbsolute.push(dir);
      };
      absoluteFs.delete = async () => {};
      absoluteFs.symlink = async (target, link) => {
        symlinks.push({ target, link });
      };
      absoluteFs.exists = async () => false;
    });

    afterEach(() => {
      storageFs.ensureDir = originalStorageEnsureDir;
      storageFs.fullPath = originalStorageFullPath;
      workspaceFs.relativePath = originalWorkspaceRelativePath;
      workspaceFs.getPath = originalWorkspaceGetPath;
      workspaceFs.fullPath = originalWorkspaceFullPath;
      workspaceFs.exists = originalWorkspaceExists;
      workspaceFs.read = originalWorkspaceRead;
      workspaceFs.write = originalWorkspaceWrite;
      absoluteFs.ensureDir = originalAbsoluteEnsureDir;
      absoluteFs.delete = originalAbsoluteDelete;
      absoluteFs.symlink = originalAbsoluteSymlink;
      absoluteFs.exists = originalAbsoluteExists;
    });

    test('writes diff output inside the task run directory', async () => {
      const executionId = 'exec-99';
      const runFiles = new TaskRunFileService(executionId as any);
      const service = new LaTeXdiffService('TestChannel');

      const executor = (service as any).commandExecutor as {
        executeDiff: (
          input: string,
          edited: string,
          options?: { cwd?: string },
        ) => Promise<{
          success: boolean;
          stdout: string;
          stderr: string | null;
          timedOut: boolean;
        }>;
      };
      const originalExecuteDiff = executor.executeDiff;
      executor.executeDiff = async (_input, _edited, options) => {
        capturedCwd = options?.cwd;
        return {
          success: true,
          stdout: 'diff-content',
          stderr: null,
          timedOut: false,
        };
      };

      const processor = (service as any).fileProcessor as {
        processDiffFile: (file: string) => Promise<void>;
      };
      const originalProcessDiffFile = processor.processDiffFile;
      processor.processDiffFile = async () => {};

      try {
        const result = await service.runDiff(
          '/mock/workspace/docs/base.tex',
          path.join(
            '/mock/storage',
            TASK_RUNS_DIR,
            executionId,
            'docs',
            'edited.tex',
          ),
          '_diff',
          false,
          undefined,
          { runFiles },
        );

        const expectedDiffPath = path.join(
          '/mock/storage',
          TASK_RUNS_DIR,
          executionId,
          'docs',
          'base_diff.tex',
        );

        assert.equal(result.success, true);
        assert.equal(result.outputPath, expectedDiffPath);
        assert.equal(
          result.workspacePath,
          path.join('/mock/workspace', 'docs', 'base_diff.tex'),
        );

        assert.deepStrictEqual(ensuredStorage, [
          TASK_RUNS_DIR,
          path.join(TASK_RUNS_DIR, executionId),
          path.join(TASK_RUNS_DIR, executionId, 'docs'),
        ]);
        assert.deepStrictEqual(ensuredAbsolute, [
          path.join('/mock/storage', TASK_RUNS_DIR, executionId, 'docs'),
          path.join('/mock/storage', TASK_RUNS_DIR, executionId, 'docs'),
        ]);
        assert.deepStrictEqual(symlinks, [
          {
            target: '/mock/workspace/docs/base.tex',
            link: path.join(
              '/mock/storage',
              TASK_RUNS_DIR,
              executionId,
              'docs',
              'base.tex',
            ),
          },
        ]);
        assert.equal(writes.length, 1);
        assert.equal(writes[0].path, expectedDiffPath);
        assert.equal(typeof writes[0].content, 'string');
        assert.equal(
          capturedCwd,
          path.join('/mock/storage', TASK_RUNS_DIR, executionId),
        );
      } finally {
        executor.executeDiff = originalExecuteDiff;
        processor.processDiffFile = originalProcessDiffFile;
      }
    });
  });
});
