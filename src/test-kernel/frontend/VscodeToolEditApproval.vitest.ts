import { rm } from 'node:fs/promises';
import path from 'node:path';

import { Effect, type FileSystem, type Path } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime';
import { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { VscodeToolEditApprovalHost } from '@frontend/approval/VscodeToolEditApprovalHost';
import type { RequestDecision, RunId } from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { toolEditApprovalRequest } from '../agent/progressTestUtils';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

interface TestUri {
  readonly fsPath: string;
  readonly path: string;
  toString(): string;
}

interface TestTextDocument {
  readonly uri: TestUri;
  getText(): string;
}

interface TestTextEditor {
  readonly document: { readonly uri: TestUri };
  selections: unknown[];
  revealRange: ReturnType<typeof vi.fn>;
}

const vscodeMocks = vi.hoisted(() => ({
  closeTabs: vi.fn(async () => undefined),
  executeCommand: vi.fn(async (..._args: unknown[]) => undefined),
  showErrorMessage: vi.fn(async (..._args: unknown[]) => undefined),
  showTextDocument: vi.fn(async (..._args: unknown[]) => undefined),
  textDocuments: [] as TestTextDocument[],
  visibleTextEditors: [] as TestTextEditor[],
}));

vi.mock('vscode', () => {
  class Position {
    constructor(
      readonly line: number,
      readonly character: number,
    ) {}
  }

  class Selection {
    constructor(
      readonly anchor: Position,
      readonly active: Position,
    ) {}
  }

  class Range {
    constructor(
      readonly start: Position,
      readonly end: Position,
    ) {}
  }

  return {
    Position,
    Range,
    Selection,
    TabInputText: class {},
    TabInputTextDiff: class {},
    TextEditorRevealType: { InCenter: 0 },
    Uri: {
      file: (filePath: string): TestUri => ({
        fsPath: filePath,
        path: filePath,
        toString: () => filePath,
      }),
    },
    commands: { executeCommand: vscodeMocks.executeCommand },
    window: {
      onDidChangeVisibleTextEditors: () => ({ dispose: vi.fn() }),
      showErrorMessage: vscodeMocks.showErrorMessage,
      showTextDocument: vscodeMocks.showTextDocument,
      tabGroups: {
        all: [],
        close: vscodeMocks.closeTabs,
        onDidChangeTabs: () => ({ dispose: vi.fn() }),
      },
      visibleTextEditors: vscodeMocks.visibleTextEditors,
    },
    workspace: {
      asRelativePath: (filePath: string) => path.basename(filePath),
      getConfiguration: () => ({
        get: <T>(_key: string, defaultValue?: T) => defaultValue,
      }),
      onDidChangeConfiguration: () => ({ dispose: vi.fn() }),
      textDocuments: vscodeMocks.textDocuments,
    },
  };
});

/** The window's `request.decide`, recorded instead of sent. */
type DecideSpy = ReturnType<typeof createDecideSpy>;

function createDecideSpy() {
  return vi.fn(
    (
      _runId: RunId,
      _requestId: string,
      _decision: RequestDecision,
    ): Effect.Effect<void> => Effect.void,
  );
}

/** The host wiring point's run: `ProgressViewProvider` gives the controller's
 *  verbs the window's process runtime, and so does this suite. */
function onRuntime<A, E>(
  program: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  >,
): Promise<A> {
  return testRuntime().runPromise(program);
}

interface ApprovalHarness {
  readonly controller: ToolEditApprovalController;
  readonly decide: DecideSpy;
}

interface StartedApproval extends ApprovalHarness {
  /** The staging this request's presentation runs, so a test can await it. */
  readonly presented: Promise<void>;
  readonly requestId: string;
}

const harnesses: ApprovalHarness[] = [];
const tempDirs = useTempDirs();
const presentations: Promise<void>[] = [];
let storageRoot: string;

/** One controller per session, exactly as `ProgressViewProvider` wires it. */
function createApprovalHarness(): ApprovalHarness {
  const decide = createDecideSpy();
  const controller = new ToolEditApprovalController({
    host: new VscodeToolEditApprovalHost(
      storageRoot,
      decide,
      testRuntime(),
      // The session only backs `openBuildDisplay`, which this suite never
      // invokes; no shared fake exists that builds without a platform host.
      { roots: {} } as unknown as SessionHandle,
    ),
  });
  const harness = { controller, decide };
  harnesses.push(harness);
  return harness;
}

function requestApproval(
  controller: ToolEditApprovalController,
  filePath: string,
  runId: RunId,
): Pick<StartedApproval, 'presented' | 'requestId'> {
  const request = toolEditApprovalRequest({
    path: filePath,
    originalContent: 'old\n',
    proposedContent: 'new\n',
    sourceTool: 'write_file',
    runId,
  });
  const presented = onRuntime(controller.present(request));
  presentations.push(presented);
  return { presented, requestId: request.permission.requestId };
}

function recordDiffEditor(command: unknown, args: unknown[]): void {
  if (command !== 'vscode.diff') return;
  vscodeMocks.visibleTextEditors.push({
    document: { uri: args[1] as TestUri },
    selections: [],
    revealRange: vi.fn(),
  });
}

function currentProposedUri(): TestUri {
  const call = vscodeMocks.executeCommand.mock.calls.find(
    ([command]) => command === 'vscode.diff',
  );
  const proposedUri = call?.[2] as TestUri | undefined;
  if (!proposedUri) {
    throw new Error('Expected the proposed diff URI.');
  }
  return proposedUri;
}

async function startApproval(): Promise<StartedApproval> {
  const harness = createApprovalHarness();
  const request = requestApproval(
    harness.controller,
    '/workspace/notes.txt',
    'run-approval' as RunId,
  );
  // `present` carries staging through to the host opening its diff view — its
  // `inFlight` deferred is only filled once `preview.present()` has returned —
  // so the proposed URI is there the moment this resolves. Polling for that
  // side effect instead raced the runner: `vi.waitFor` gives up after a second,
  // and a loaded Windows shard stages slower than that.
  await request.presented;
  return { ...harness, ...request };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vscodeMocks.textDocuments.splice(0);
  vscodeMocks.visibleTextEditors.splice(0);
  vscodeMocks.executeCommand.mockImplementation(
    async (command: unknown, ...args: unknown[]) => {
      recordDiffEditor(command, args);
      return undefined;
    },
  );
  storageRoot = await makeTempDir('texra-native-approval-', tempDirs);
});

afterEach(async () => {
  for (const { controller } of harnesses.splice(0)) {
    await onRuntime(controller.dispose());
  }
  await Promise.allSettled(presentations.splice(0));
});

describe('VS Code tool edit approval', () => {
  it('reports a failed preview read and accepts a later approval', async () => {
    const { controller, decide, requestId } = await startApproval();
    const proposedUri = currentProposedUri();
    await rm(proposedUri.fsPath);

    await onRuntime(controller.handleAction({ requestId, action: 'approve' }));

    await vi.waitFor(() =>
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledOnce(),
    );
    expect(vscodeMocks.showErrorMessage.mock.calls[0]?.[0]).toEqual(
      expect.stringContaining('edited document could not be read'),
    );
    expect(decide).not.toHaveBeenCalled();

    const getText = vi.fn(() => 'beta after retry\r\n');
    vscodeMocks.textDocuments.push({ uri: proposedUri, getText });
    await onRuntime(controller.handleAction({ requestId, action: 'approve' }));

    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith('run-approval', requestId, {
        action: 'approve',
        content: 'beta after retry\n',
      }),
    );
    expect(getText).toHaveBeenCalledOnce();
  });

  it('previews a non-LaTeX proposal by opening the proposed file', async () => {
    const { controller, decide, requestId } = await startApproval();
    const proposedUri = currentProposedUri();

    await onRuntime(
      controller.handleAction({ requestId, action: 'previewProposed' }),
    );

    await vi.waitFor(() =>
      expect(vscodeMocks.showTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: proposedUri.fsPath }),
        { preview: true, preserveFocus: true },
      ),
    );
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();

    await onRuntime(controller.handleAction({ requestId, action: 'reject' }));
    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith('run-approval', requestId, {
        action: 'reject',
        feedback: null,
      }),
    );
  });
});
