// Standard library imports
import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent
import {
  AgentCategory,
  AgentType,
  type AgentWorkflowSetting,
} from '@agent/core/AgentDataclass';
import { LatexDiffManager } from '@agent/output/LatexDiffManager';

// Local imports - files
import {
  AbsoluteFS,
  StorageFS,
  TaskRunFileService,
  WorkspaceFS,
} from '@utils/files';

// Local imports - logging
import { AgentLogger } from '@logger/AgentLogger';

// Local imports - output types
import type { RoundFileMapping } from '@agent/output/types';

describe('TaskRunFileService run storage integration', () => {
  const workspaceFsAny = WorkspaceFS as unknown as {
    getPath: () => string | undefined;
    fullPath: (target: string) => string;
  };
  const storageFsAny = StorageFS as unknown as {
    fullPath: (target: string) => string;
    ensureDir: (target: string) => Promise<void>;
  };
  const absoluteFsAny = AbsoluteFS as unknown as {
    exists: (target: string) => Promise<boolean>;
    read: (target: string) => Promise<string>;
    write: (target: string, content: string | Uint8Array) => Promise<void>;
  };

  const originalWorkspaceGetPath = workspaceFsAny.getPath;
  const originalWorkspaceFullPath = workspaceFsAny.fullPath;
  const originalStorageFullPath = storageFsAny.fullPath;
  const originalStorageEnsureDir = storageFsAny.ensureDir;
  const originalAbsoluteExists = absoluteFsAny.exists;
  const originalAbsoluteRead = absoluteFsAny.read;
  const originalAbsoluteWrite = absoluteFsAny.write;
  const originalGetConfiguration = vscode.workspace.getConfiguration;

  let workspaceRoot: string;
  let storageRoot: string;

  beforeEach(async () => {
    workspaceRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), 'texra-workspace-'),
    );
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'texra-storage-'));

    workspaceFsAny.getPath = () => workspaceRoot;
    workspaceFsAny.fullPath = (target: string) =>
      path.isAbsolute(target) ? target : path.join(workspaceRoot, target);

    storageFsAny.fullPath = (target: string) => path.join(storageRoot, target);
    storageFsAny.ensureDir = async (target: string) => {
      await fs.mkdir(path.join(storageRoot, target), { recursive: true });
    };

    absoluteFsAny.exists = async (target: string) => {
      try {
        await fs.access(target);
        return true;
      } catch {
        return false;
      }
    };
    absoluteFsAny.read = async (target: string) => fs.readFile(target, 'utf-8');
    absoluteFsAny.write = async (
      target: string,
      content: string | Uint8Array,
    ) => {
      const data = typeof content === 'string' ? content : Buffer.from(content);
      await fs.writeFile(target, data);
    };

    (vscode.workspace as any).getConfiguration = (section?: string) => {
      if (section === 'texra') {
        return {
          get: (key: string) =>
            key === 'agentOutputs.storageMode' ? 'taskRunStorage' : undefined,
        };
      }

      if (!section) {
        return {
          get: (key: string) =>
            key === 'texra.agentOutputs.storageMode'
              ? 'taskRunStorage'
              : undefined,
        };
      }

      return { get: () => undefined };
    };
  });

  afterEach(async () => {
    workspaceFsAny.getPath = originalWorkspaceGetPath;
    workspaceFsAny.fullPath = originalWorkspaceFullPath;
    storageFsAny.fullPath = originalStorageFullPath;
    storageFsAny.ensureDir = originalStorageEnsureDir;
    absoluteFsAny.exists = originalAbsoluteExists;
    absoluteFsAny.read = originalAbsoluteRead;
    absoluteFsAny.write = originalAbsoluteWrite;
    (vscode.workspace as any).getConfiguration = originalGetConfiguration;

    await fs.rm(workspaceRoot, { recursive: true, force: true });
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  function createLogger(): AgentLogger {
    const logger = new AgentLogger('TaskRunFileServiceTest');
    const noop = () => {};
    (logger as any).debug = noop;
    (logger as any).info = noop;
    (logger as any).warn = noop;
    (logger as any).error = noop;
    (logger as any).latexDiff = noop;
    return logger;
  }

  const agentSetting: AgentWorkflowSetting = {
    agentType: AgentType.CoT,
    agentCategory: AgentCategory.Workflow,
    documentTag: 'document',
    temperature: 0,
    isRewrite: true,
    rounds: 1,
    prefills: [],
    outputExt: 'tex',
    endTag: '</latex_document>',
    requiredFiles: {},
    requiredFilesInternal: {},
    defaultOutputFiles: [],
    isMultipleOutput: false,
    filePatternsContain: [],
    tools: [],
  };

  it('relocates files to run storage while keeping workspace access', async () => {
    const executionId = 'exec-123';
    const service = new TaskRunFileService(executionId);
    const workspaceFile = path.join(workspaceRoot, 'outputs', 'result.tex');
    await fs.mkdir(path.dirname(workspaceFile), { recursive: true });
    await fs.writeFile(workspaceFile, 'workspace-content');

    const relocation = await service.relocateToRunStorage(workspaceFile);

    const expectedStoragePath = path.join(
      storageRoot,
      'taskRuns',
      executionId,
      'outputs',
      'result.tex',
    );
    assert.strictEqual(relocation.storagePath, expectedStoragePath);
    assert.strictEqual(relocation.workspacePath, workspaceFile);

    const storageContent = await fs.readFile(relocation.storagePath, 'utf-8');
    assert.strictEqual(storageContent, 'workspace-content');

    const workspaceStat = await fs.lstat(workspaceFile);
    if (workspaceStat.isSymbolicLink()) {
      const linkTarget = await fs.readlink(workspaceFile);
      assert.strictEqual(linkTarget, expectedStoragePath);
    } else {
      assert.ok(workspaceStat.isFile());
      const workspaceContent = await fs.readFile(workspaceFile, 'utf-8');
      assert.strictEqual(workspaceContent, 'workspace-content');
    }
  });

  it('prefers workspace paths for latexdiff when files are relocated', async () => {
    const executionId = 'exec-456';
    const service = new TaskRunFileService(executionId);
    const baseFile = path.join(workspaceRoot, 'paper.tex');
    const outputFile = path.join(workspaceRoot, 'paper_r0.tex');
    await fs.writeFile(baseFile, 'base');
    await fs.writeFile(outputFile, 'revised');

    const relocation = await service.relocateToRunStorage(outputFile);

    const outputFiles: { [key: number]: string[] } = {
      0: [relocation.storagePath],
    };
    const mapping: RoundFileMapping = {
      baseToOutput: new Map([[baseFile, relocation.storagePath]]),
      prevToOutput: new Map(),
      originByOutput: new Map([[relocation.storagePath, outputFile]]),
      workspaceByOutput: new Map([[relocation.storagePath, outputFile]]),
    };

    const logger = createLogger();
    const dependencies = {
      checkToolInstalled: async () => true,
      compileLatex2Pdf: async () => true,
      getConfig: <T>(_: string, defaultValue?: T) => defaultValue as T,
    };

    const manager = new LatexDiffManager(
      agentSetting,
      outputFiles,
      [baseFile],
      logger,
      'channel',
      service,
      dependencies,
    );

    const calls: Array<{
      base: string;
      revised: string;
      options?: { cwd?: string };
    }> = [];

    (manager as any).latexdiffService = {
      runDiffForRound: async (
        base: string,
        revised: string,
        _round: number,
        _unused: unknown,
        options?: { cwd?: string },
      ) => {
        calls.push({ base, revised, options });
        return { success: true };
      },
      runDiffBetweenRounds: async () => ({ success: true }),
    };

    await manager.handleLatexdiffofOutput(0, mapping);

    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].base, baseFile);
    assert.strictEqual(calls[0].revised, outputFile);
    assert.strictEqual(calls[0].options?.cwd, path.dirname(outputFile));
  });
});
