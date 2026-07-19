// Node imports
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

// Third-party imports
import { afterEach, describe, expect, it, vi } from 'vitest';

// Local imports - platform
import { MemoryStateStore } from '@platform/defaults/memoryState';
import { nodeFilesystem } from '@platform/defaults/nodeFilesystem';
import { createNodeWorkspace } from '@platform/defaults/nodeWorkspace';
import { WorkspaceStorageProvider } from '@platform/defaults/workspaceStorage';
import { createFakePlatform } from '@test/support/FakePlatform';
import { cleanupTempDirs } from '@test/support/tempDirPlatform';

// Local imports - shared schemas and tools
import { RUN_OUTCOME, type StreamTabId } from '@shared/schemas';
import { DIAGNOSTICS_READ_RUNTIME_CAPABILITY } from '@tools/diagnosticsRuntimeCapabilities';
import { SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES } from '@tools/setup/platform';

// Local imports - desktop test support
import {
  createStubDesktopAgentExecutionHost,
  disposeAfterTest,
  makeFakeTrace,
  type DesktopAgentExecutionModule,
  type RunExecutionRequest,
} from './desktopAgentExecutionTestHarness.mjs';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import type { FileSystemProvider } from '@platform/interfaces';
import type { Platform } from '@platform/platform';

type DesktopExecution = {
  handleExecute(message: unknown): Promise<void>;
  progress: {
    openFileCompile(filePath: string): Promise<void>;
  };
  dispose(): void;
};

type SnapshotStore = import('@transcript').StreamSnapshotStore;

type LegacyRow = Record<string, unknown> & { streamId: string };

const tempDirs: string[] = [];

function makeLegacyRow(streamId: string): LegacyRow {
  return {
    streamId,
    label: `Legacy ${streamId}`,
    agent: 'workflowAgent',
    agentCategory: 'workflow',
    inputFile: 'paper.tex',
    instruction: 'Polish the proof',
    lastKnownStatus: 'completed',
    executionId: 'abc-8544',
    creationTimestamp: 1_700_000_000_000,
    lastTimestamp: 1_700_000_500_000,
    persistedAt: 1_700_000_500_500,
  };
}

function serializeLegacyRows(rows: LegacyRow[]): string {
  return `${JSON.stringify(
    {
      restoredStreams: {
        version: 1,
        streams: rows,
      },
    },
    null,
    2,
  )}\n`;
}

async function createPersistentHarness(
  options: {
    fs?: FileSystemProvider;
  } = {},
): Promise<{ legacyFilePath: string; platform: Platform }> {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'texra-factory-8544-'));
  tempDirs.push(tempDir);
  const workspaceDir = path.join(tempDir, 'workspace');
  const storageRoot = path.join(tempDir, 'storage');
  return {
    legacyFilePath: path.join(tempDir, 'streams.json'),
    platform: createFakePlatform(
      { workspacePath: workspaceDir },
      {
        fs: options.fs ?? nodeFilesystem,
        workspace: createNodeWorkspace(() => workspaceDir),
        storage: new WorkspaceStorageProvider(storageRoot, workspaceDir),
        globalState: new MemoryStateStore(),
        workspaceState: new MemoryStateStore(),
      },
    ),
  };
}

function createMigrationFailureFilesystem(
  failurePoint: 'transcript-flush' | 'canonical-load',
  failure: Error,
): FileSystemProvider {
  let streamLogDirectoryReads = 0;
  return {
    ...nodeFilesystem,
    async writeFileAtomic(target, content) {
      if (
        failurePoint === 'transcript-flush' &&
        path.basename(path.dirname(target)) === 'streamLogs'
      ) {
        throw failure;
      }
      await nodeFilesystem.writeFileAtomic(target, content);
    },
    async readDirectory(target) {
      if (
        failurePoint === 'canonical-load' &&
        path.basename(target) === 'streamLogs' &&
        ++streamLogDirectoryReads === 2
      ) {
        throw failure;
      }
      return nodeFilesystem.readDirectory(target);
    },
  };
}

async function persistSidecarRegistration(
  snapshots: SnapshotStore,
  streamId: StreamTabId,
): Promise<void> {
  snapshots.setDescription(streamId, 'Sidecar registration evidence');
  await snapshots.flush();
}

async function readCanonicalStreamIds(): Promise<string[]> {
  const { StreamLogStore } = await import('@transcript');
  return (await StreamLogStore.open()).keys();
}

async function readCanonicalDescription(
  streamId: StreamTabId,
): Promise<string | undefined> {
  const { StreamSnapshotStore } = await import('@transcript');
  const snapshots = new StreamSnapshotStore();
  await snapshots.load([streamId]);
  return snapshots.getDescription(streamId);
}

async function persistCanonicalTranscript(
  platform: Platform,
  streamId: StreamTabId,
): Promise<void> {
  vi.resetModules();
  const { initPlatform } = await import('@platform/platform');
  initPlatform(platform);
  const { StreamLogStore } = await import('@transcript');
  const transcripts = await StreamLogStore.open();
  transcripts.ensureStream(streamId);
  await transcripts.flush();
}

async function createExecution(options: {
  postToRenderer?: (message: unknown) => void;
  opener?: {
    openPath(filePath: string): Promise<void>;
    openBuildDisplay?(location: { absolutePath: string }): Promise<void>;
  };
  showErrorMessage?: (message: string) => Promise<void> | void;
  prepareMainViewExecutionRequest: (message: unknown) => unknown;
  runAgent?: RunExecutionRequest;
  onRunCompleted?: () => void;
  transcriptOpenError?: Error;
  platform?: Platform;
  useRealStorage?: boolean;
  legacyStreamFilePath?: string;
  legacyCleanupWriteError?: Error;
  prepareSnapshotStore?: (store: SnapshotStore) => Promise<void>;
}): Promise<DesktopExecution> {
  vi.resetModules();
  const { initPlatform } = await import('@platform/platform');
  initPlatform(options.platform ?? createFakePlatform());
  vi.doMock('@agent/runtime/SessionResumeRetrieval', () => ({
    retrieveSessionResumeData: vi.fn(async () => null),
  }));
  vi.doMock('@agent/runtime/executeAgent', () => ({
    resumeToolUseFromResumeData: vi.fn(async () => {}),
  }));
  vi.doMock('@agent/runtime/runAgent', () => ({
    runAgent: options.runAgent ?? vi.fn(async () => {}),
  }));
  if (options.useRealStorage) {
    vi.doUnmock('@common/storage/KVStore');
  } else {
    vi.doMock('@common/storage/KVStore', () => ({
      KVStore: class {
        async read(): Promise<undefined> {
          return undefined;
        }

        async write(): Promise<void> {}

        async delete(): Promise<void> {}

        async deleteDir(): Promise<void> {}

        async exists(): Promise<boolean> {
          return false;
        }

        async listKeys(): Promise<string[]> {
          if (options.transcriptOpenError) throw options.transcriptOpenError;
          return [];
        }
      },
    }));
  }
  if (options.legacyCleanupWriteError) {
    vi.doMock('write-file-atomic', () => ({
      default: vi.fn(async () => {
        throw options.legacyCleanupWriteError;
      }),
    }));
  } else {
    vi.doUnmock('write-file-atomic');
  }
  vi.doMock('@controllers/mainView/MainViewExecutionController', () => ({
    prepareMainViewExecutionRequest: options.prepareMainViewExecutionRequest,
  }));
  const { createDesktopAgentExecution } = (await import(
    moduleFileUrl(desktopSourcePath('main', 'desktopAgentExecution.ts'))
  )) as DesktopAgentExecutionModule;
  const { StreamSnapshotStore } = await import('@transcript');
  const progressSnapshotStore = new StreamSnapshotStore();
  await options.prepareSnapshotStore?.(progressSnapshotStore);
  return disposeAfterTest(
    await createDesktopAgentExecution({
      postToRenderer: options.postToRenderer ?? vi.fn(),
      progressSnapshotStore,
      ...(options.legacyStreamFilePath
        ? { legacyStreamFilePath: options.legacyStreamFilePath }
        : {}),
      host: createStubDesktopAgentExecutionHost({
        ...(options.opener?.openPath
          ? { openPath: options.opener.openPath }
          : {}),
        ...(options.opener?.openBuildDisplay
          ? { openBuildDisplay: options.opener.openBuildDisplay }
          : {}),
        ...(options.showErrorMessage
          ? { showErrorMessage: options.showErrorMessage }
          : {}),
        ...(options.onRunCompleted
          ? { onRunCompleted: options.onRunCompleted }
          : {}),
      }),
    }),
  );
}

describe('createDesktopAgentExecution', () => {
  afterEach(async () => {
    vi.doUnmock('@agent/runtime/SessionResumeRetrieval');
    vi.doUnmock('@agent/runtime/executeAgent');
    vi.doUnmock('@agent/runtime/runAgent');
    vi.doUnmock('@common/storage/KVStore');
    vi.doUnmock('@controllers/mainView/MainViewExecutionController');
    vi.doUnmock('write-file-atomic');
    vi.restoreAllMocks();
    await cleanupTempDirs(tempDirs);
  });

  it('durably registers a sidecar-only legacy claim before removing its source', async () => {
    const streamId = 'proofreader@gpt#sidecar8544' as StreamTabId;
    const { legacyFilePath, platform } = await createPersistentHarness();
    await writeFile(
      legacyFilePath,
      serializeLegacyRows([makeLegacyRow(streamId)]),
    );

    await createExecution({
      platform,
      useRealStorage: true,
      legacyStreamFilePath: legacyFilePath,
      prepareSnapshotStore: (snapshots) =>
        persistSidecarRegistration(snapshots, streamId),
      prepareMainViewExecutionRequest: vi.fn(),
    });

    expect(await readCanonicalStreamIds()).toContain(streamId);
    await expect(readFile(legacyFilePath)).rejects.toMatchObject({
      code: 'ENOENT',
    });

    await createExecution({
      platform,
      useRealStorage: true,
      prepareMainViewExecutionRequest: vi.fn(),
    });
    expect(await readCanonicalStreamIds()).toContain(streamId);
    expect(await readCanonicalDescription(streamId)).toBe(
      'Sidecar registration evidence',
    );
  });

  it('keeps canonical metadata for a stream also present in legacy state', async () => {
    const streamId = 'proofreader@gpt#overlap8544' as StreamTabId;
    const { legacyFilePath, platform } = await createPersistentHarness();
    await persistCanonicalTranscript(platform, streamId);
    await writeFile(
      legacyFilePath,
      serializeLegacyRows([
        makeLegacyRow(streamId),
        makeLegacyRow('other-workspace@gpt#overlap8544'),
      ]),
    );

    await createExecution({
      platform,
      useRealStorage: true,
      legacyStreamFilePath: legacyFilePath,
      prepareSnapshotStore: (snapshots) =>
        persistSidecarRegistration(snapshots, streamId),
      prepareMainViewExecutionRequest: vi.fn(),
    });

    expect(
      (await readCanonicalStreamIds()).filter((id) => id === streamId),
    ).toHaveLength(1);
    expect(await readCanonicalDescription(streamId)).toBe(
      'Sidecar registration evidence',
    );
    const retained = JSON.parse(await readFile(legacyFilePath, 'utf8')) as {
      restoredStreams: { streams: LegacyRow[] };
    };
    expect(retained.restoredStreams.streams.map((row) => row.streamId)).toEqual(
      ['other-workspace@gpt#overlap8544'],
    );
  });

  it('retains an unmatched global legacy row without importing it', async () => {
    const streamId = 'other-workspace@gpt#8544' as StreamTabId;
    const { legacyFilePath, platform } = await createPersistentHarness();
    const original = serializeLegacyRows([makeLegacyRow(streamId)]);
    await writeFile(legacyFilePath, original);

    await createExecution({
      platform,
      useRealStorage: true,
      legacyStreamFilePath: legacyFilePath,
      prepareMainViewExecutionRequest: vi.fn(),
    });

    expect(await readCanonicalStreamIds()).not.toContain(streamId);
    expect(await readFile(legacyFilePath, 'utf8')).toBe(original);
  });

  it('retains malformed legacy state while canonical startup remains usable', async () => {
    const { legacyFilePath, platform } = await createPersistentHarness();
    const malformed = '{"restoredStreams"';
    await writeFile(legacyFilePath, malformed);

    await expect(
      createExecution({
        platform,
        useRealStorage: true,
        legacyStreamFilePath: legacyFilePath,
        prepareMainViewExecutionRequest: vi.fn(),
      }),
    ).resolves.toBeDefined();

    expect(await readCanonicalStreamIds()).toEqual([]);
    expect(await readFile(legacyFilePath, 'utf8')).toBe(malformed);
  });

  it.each([
    ['transcript-flush', 'Transcript flush failed'],
    ['canonical-load', 'canonical transcript load failed'],
  ] as const)(
    'retains legacy state when %s fails before migration commit',
    async (failurePoint, expectedMessage) => {
      const streamId = `proofreader@gpt#${failurePoint}8544` as StreamTabId;
      const failure = new Error(
        failurePoint === 'transcript-flush'
          ? 'transcript registration write failed'
          : expectedMessage,
      );
      const fs = createMigrationFailureFilesystem(failurePoint, failure);
      const { legacyFilePath, platform } = await createPersistentHarness({
        fs,
      });
      const original = serializeLegacyRows([makeLegacyRow(streamId)]);
      await writeFile(legacyFilePath, original);

      await expect(
        createExecution({
          platform,
          useRealStorage: true,
          legacyStreamFilePath: legacyFilePath,
          prepareSnapshotStore: (snapshots) =>
            persistSidecarRegistration(snapshots, streamId),
          prepareMainViewExecutionRequest: vi.fn(),
        }),
      ).rejects.toThrow(expectedMessage);
      expect(await readFile(legacyFilePath, 'utf8')).toBe(original);
    },
  );

  it('retains the legacy source when cleanup fails but keeps canonical startup usable', async () => {
    const streamId = 'proofreader@gpt#cleanup8544' as StreamTabId;
    const unmatchedStreamId = 'other-workspace@gpt#cleanup8544' as StreamTabId;
    const cleanupFailure = new Error('legacy cleanup write failed');
    const { legacyFilePath, platform } = await createPersistentHarness();
    const original = serializeLegacyRows([
      makeLegacyRow(streamId),
      makeLegacyRow(unmatchedStreamId),
    ]);
    await writeFile(legacyFilePath, original);

    await expect(
      createExecution({
        platform,
        useRealStorage: true,
        legacyStreamFilePath: legacyFilePath,
        legacyCleanupWriteError: cleanupFailure,
        prepareSnapshotStore: (snapshots) =>
          persistSidecarRegistration(snapshots, streamId),
        prepareMainViewExecutionRequest: vi.fn(),
      }),
    ).resolves.toBeDefined();

    expect(await readCanonicalStreamIds()).toContain(streamId);
    expect(await readCanonicalStreamIds()).not.toContain(unmatchedStreamId);
    expect(await readFile(legacyFilePath, 'utf8')).toBe(original);

    await createExecution({
      platform,
      useRealStorage: true,
      prepareMainViewExecutionRequest: vi.fn(),
    });
    expect(await readCanonicalStreamIds()).toContain(streamId);
    expect(await readFile(legacyFilePath, 'utf8')).toBe(original);
  });

  it('fails initialization when persistent transcripts cannot be opened', async () => {
    const failure = new Error('desktop transcript storage unavailable');

    await expect(
      createExecution({
        transcriptOpenError: failure,
        prepareMainViewExecutionRequest: vi.fn(),
      }),
    ).rejects.toBe(failure);
  });

  it('surfaces invalid execution requests through the host error path', async () => {
    const postToRenderer = vi.fn();
    const showErrorMessage = vi.fn();
    const runAgent = vi.fn(async () => {});
    const execution = await createExecution({
      postToRenderer,
      showErrorMessage,
      runAgent,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: false,
        message: 'Select an input file first.',
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(showErrorMessage).toHaveBeenCalledWith(
      'Select an input file first.',
    );
    expect(postToRenderer).not.toHaveBeenCalled();
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('lets runtime execution errors propagate to the IPC error handler', async () => {
    const failure = new Error('execution failed');
    const execution = await createExecution({
      runAgent: vi.fn(async () => {
        throw failure;
      }),
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
    });

    await expect(
      execution.handleExecute({ command: 'execute' }),
    ).rejects.toThrow(failure);
  });

  it('passes remote agent launches to the shared runtime unchanged', async () => {
    const request = {
      agentName: 'remote:remoteWriter',
      filePath: 'main.tex',
      prompt: 'draft',
    };
    const runAgent = vi.fn(async () => {});
    const execution = await createExecution({
      runAgent,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request,
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(runAgent).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        openWorkflowOutput: expect.any(Function),
        runtimeUnavailableTools: [
          ...SETUP_PLATFORM_VSCODE_ONLY_TOOL_NAMES,
          'inline_comment',
          DIAGNOSTICS_READ_RUNTIME_CAPABILITY,
        ],
      }),
    );
  });

  it('opens workflow outputs through the desktop preview host', async () => {
    const opener = { openPath: vi.fn(async (_filePath: string) => {}) };
    const runAgent = vi.fn(async (_request, options) => {
      await options.openWorkflowOutput({
        outcome: RUN_OUTCOME.COMPLETED,
        outputs: [{ absolutePath: '/tmp/result.pdf', round: 0 }],
      });
    });
    const execution = await createExecution({
      opener,
      runAgent,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(opener.openPath).toHaveBeenCalledWith('/tmp/result.pdf');
  });

  it('fires onRunCompleted when a run reaches a completed terminal result', async () => {
    const onRunCompleted = vi.fn();
    // The mock run bridges a trace into the window session's onResult channel
    // (mirroring AgentLaunchContext.attachRunTrace) and emits a completed
    // result — exactly what the lifecycle does after persisting firstRunDone.
    const runAgent = vi.fn(async (_request, options) => {
      const trace = makeFakeTrace();
      options.session.attachRunTrace(trace, 'stream-1');
      trace.emit({
        type: 'result',
        outcome: RUN_OUTCOME.COMPLETED,
        executionId: 'ec1001',
        streamId: 'stream-1',
        agentName: 'proofreader',
        category: 'workflow',
        isSubagent: false,
      });
    });
    const execution = await createExecution({
      runAgent,
      onRunCompleted,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(onRunCompleted).toHaveBeenCalledOnce();
  });

  it('does not fire onRunCompleted on a failed terminal result', async () => {
    const onRunCompleted = vi.fn();
    const runAgent = vi.fn(async (_request, options) => {
      const trace = makeFakeTrace();
      options.session.attachRunTrace(trace, 'stream-2');
      trace.emit({
        type: 'result',
        outcome: RUN_OUTCOME.FAILED,
        executionId: 'exec-2',
        streamId: 'stream-2',
        agentName: 'proofreader',
        category: 'workflow',
        isSubagent: false,
      });
    });
    const execution = await createExecution({
      runAgent,
      onRunCompleted,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(onRunCompleted).not.toHaveBeenCalled();
  });

  it('does not auto-open outputs of a non-completed workflow', async () => {
    const opener = { openPath: vi.fn(async (_filePath: string) => {}) };
    const runAgent = vi.fn(async (_request, options) => {
      await options.openWorkflowOutput({
        outcome: RUN_OUTCOME.CANCELLED,
        outputs: [{ absolutePath: '/tmp/result.pdf', round: 0 }],
      });
    });
    const execution = await createExecution({
      opener,
      runAgent,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: true,
        request: {
          agentName: 'default',
          filePath: 'main.tex',
          prompt: 'run',
        },
      })),
    });

    await execution.handleExecute({ command: 'execute' });
    expect(opener.openPath).not.toHaveBeenCalled();
  });

  it('opens compile-file actions through the desktop preview host', async () => {
    const opener = {
      openPath: vi.fn(async (_filePath: string) => {}),
      openBuildDisplay: vi.fn(
        async (_location: { absolutePath: string }) => {},
      ),
    };
    const execution = await createExecution({
      opener,
      prepareMainViewExecutionRequest: vi.fn(() => ({
        valid: false,
        message: 'not used',
      })),
    });

    await execution.progress.openFileCompile('/tmp/output.tex');
    expect(opener.openBuildDisplay).toHaveBeenCalledWith(
      expect.objectContaining({ absolutePath: '/tmp/output.tex' }),
    );
    expect(opener.openPath).not.toHaveBeenCalled();
  });
});
