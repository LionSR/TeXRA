import { rm } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { VscodeToolEditApprovalHost } from '@frontend/approval/VscodeToolEditApprovalHost';
import type { RequestDecision, RunId } from '@shared/schemas';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import { toolEditApprovalRequest } from '../agent/progressTestUtils';

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
    async (
      _runId: RunId,
      _requestId: string,
      _decision: RequestDecision,
    ): Promise<void> => undefined,
  );
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
    host: new VscodeToolEditApprovalHost(storageRoot, decide),
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
  const presented = controller.present(request);
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
  await vi.waitFor(() => expect(currentProposedUri()).toBeDefined());
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
    controller.dispose();
  }
  await Promise.allSettled(presentations.splice(0));
});

describe('VS Code tool edit approval', () => {
  it('approves a matching edit while its preview is still initializing', async () => {
    const { controller, decide } = createApprovalHarness();
    const { presented, requestId } = requestApproval(
      controller,
      '/workspace/approve-initializing.txt',
      'run-initializing' as RunId,
    );

    await expect(
      controller.approvePendingForRun('run-initializing' as RunId),
    ).resolves.toBeUndefined();
    await presented;

    // Nothing was staged for the user to edit, so the proposal itself is
    // the approved content.
    expect(decide).toHaveBeenCalledWith('run-initializing', requestId, {
      action: 'approve',
      content: 'new\n',
    });
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  });

  it('approves a matching edit whose preview is already pending', async () => {
    const { controller, decide, requestId } = await startApproval();

    await expect(
      controller.approvePendingForRun('run-approval' as RunId),
    ).resolves.toBeUndefined();

    expect(decide).toHaveBeenCalledWith('run-approval', requestId, {
      action: 'approve',
      content: 'new\n',
    });
  });

  it('keeps each session controller scoped to its own requests', async () => {
    const target = createApprovalHarness();
    const other = createApprovalHarness();
    const { requestId: targetRequestId } = requestApproval(
      target.controller,
      '/workspace/target.txt',
      'run-target' as RunId,
    );
    requestApproval(
      target.controller,
      '/workspace/other-stream.txt',
      'run-other' as RunId,
    );
    requestApproval(
      other.controller,
      '/workspace/other-session.txt',
      'run-target' as RunId,
    );
    await vi.waitFor(() =>
      expect(
        vscodeMocks.executeCommand.mock.calls.filter(
          ([command]) => command === 'vscode.diff',
        ),
      ).toHaveLength(3),
    );

    await target.controller.approvePendingForRun('run-target' as RunId);

    // One request decided: this controller's own, on that run. The other
    // run's request and the other session's request for the same run are
    // untouched.
    expect(target.decide).toHaveBeenCalledOnce();
    expect(target.decide).toHaveBeenCalledWith('run-target', targetRequestId, {
      action: 'approve',
      content: 'new\n',
    });
    expect(other.decide).not.toHaveBeenCalled();
  });

  it('reports a failed preview read and accepts a later approval', async () => {
    const { controller, decide, requestId } = await startApproval();
    const proposedUri = currentProposedUri();
    await rm(proposedUri.fsPath);

    controller.handleAction({ requestId, action: 'approve' });

    await vi.waitFor(() =>
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledOnce(),
    );
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('edited document could not be read'),
    );
    expect(decide).not.toHaveBeenCalled();

    const getText = vi.fn(() => 'beta after retry\r\n');
    vscodeMocks.textDocuments.push({ uri: proposedUri, getText });
    controller.handleAction({ requestId, action: 'approve' });

    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith('run-approval', requestId, {
        action: 'approve',
        content: 'beta after retry\n',
      }),
    );
    expect(getText).toHaveBeenCalledOnce();
  });

  it('accepts the current edited document content', async () => {
    const { controller, decide, requestId } = await startApproval();
    const getText = vi.fn(() => 'beta edited\r\n');
    vscodeMocks.textDocuments.push({
      uri: currentProposedUri(),
      getText,
    });

    controller.handleAction({ requestId, action: 'approve' });

    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith('run-approval', requestId, {
        action: 'approve',
        content: 'beta edited\n',
      }),
    );
    expect(getText).toHaveBeenCalledOnce();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it('previews a non-LaTeX proposal by opening the proposed file', async () => {
    const { controller, decide, requestId } = await startApproval();
    const proposedUri = currentProposedUri();

    controller.handleAction({ requestId, action: 'previewProposed' });

    await vi.waitFor(() =>
      expect(vscodeMocks.showTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: proposedUri.fsPath }),
        { preview: true, preserveFocus: true },
      ),
    );
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();

    controller.handleAction({ requestId, action: 'reject' });
    await vi.waitFor(() =>
      expect(decide).toHaveBeenCalledWith('run-approval', requestId, {
        action: 'reject',
        feedback: null,
      }),
    );
  });
});
