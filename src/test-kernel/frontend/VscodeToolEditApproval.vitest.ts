import { rm } from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { ToolEditApprovalController } from '@controllers/approval/ToolEditApprovalController';
import { VscodeToolEditApprovalHost } from '@frontend/approval/VscodeToolEditApprovalHost';
import { createTestSession } from '@test/support/sessionTestUtils';
import { makeTempDir, useTempDirs } from '@test/support/tempDirPlatform';
import type { ToolEditApprovalResult } from '@tools/approval/toolEditApproval';
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

interface ApprovalHarness {
  readonly controller: ToolEditApprovalController;
  readonly session: SessionHandle;
}

interface StartedApproval extends ApprovalHarness {
  readonly approval: Promise<ToolEditApprovalResult>;
  readonly requestId: string;
}

const harnesses: ApprovalHarness[] = [];
const tempDirs = useTempDirs();
const activeApprovals: Promise<ToolEditApprovalResult>[] = [];
let storageRoot: string;

/** One controller per session, exactly as `ProgressViewProvider` wires it. */
function createApprovalHarness(): ApprovalHarness {
  const session = createTestSession();
  const controller = new ToolEditApprovalController({
    host: new VscodeToolEditApprovalHost(storageRoot),
    session,
  });
  const harness = { controller, session };
  harnesses.push(harness);
  return harness;
}

function requestApproval(
  controller: ToolEditApprovalController,
  filePath: string,
  streamId: string,
): Pick<StartedApproval, 'approval' | 'requestId'> {
  const request = toolEditApprovalRequest({
    path: filePath,
    originalContent: 'old\n',
    proposedContent: 'new\n',
    sourceTool: 'write_file',
    streamId,
  });
  const approval = controller.requestApproval(request);
  activeApprovals.push(approval);
  return { approval, requestId: request.permission.requestId };
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
    'stream-approval',
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
  for (const { controller, session } of harnesses.splice(0)) {
    controller.dispose();
    session.dispose();
  }
  await Promise.allSettled(activeApprovals.splice(0));
});

describe('VS Code tool edit approval', () => {
  it('approves a matching edit while its preview is still initializing', async () => {
    const { controller } = createApprovalHarness();
    const { approval } = requestApproval(
      controller,
      '/workspace/approve-initializing.txt',
      'stream-initializing',
    );

    await expect(
      controller.approvePendingForStream('stream-initializing'),
    ).resolves.toBeUndefined();
    await expect(approval).resolves.toMatchObject({
      action: 'apply',
      appliedContent: 'new\n',
    });
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  });

  it('approves a matching edit whose preview is already pending', async () => {
    const { approval, controller } = await startApproval();

    await expect(
      controller.approvePendingForStream('stream-approval'),
    ).resolves.toBeUndefined();
    await expect(approval).resolves.toMatchObject({
      action: 'apply',
      appliedContent: 'new\n',
    });
  });

  it('keeps each session controller scoped to its own requests', async () => {
    const target = createApprovalHarness();
    const other = createApprovalHarness();
    const { approval: targetStream } = requestApproval(
      target.controller,
      '/workspace/target.txt',
      'stream-target',
    );
    const { approval: otherStream } = requestApproval(
      target.controller,
      '/workspace/other-stream.txt',
      'stream-other',
    );
    const { approval: otherSessionRequest } = requestApproval(
      other.controller,
      '/workspace/other-session.txt',
      'stream-target',
    );
    await vi.waitFor(() =>
      expect(
        vscodeMocks.executeCommand.mock.calls.filter(
          ([command]) => command === 'vscode.diff',
        ),
      ).toHaveLength(3),
    );

    await target.controller.approvePendingForStream('stream-target');
    await expect(targetStream).resolves.toMatchObject({ action: 'apply' });

    target.controller.cancel({ streamId: 'stream-other' });
    other.controller.cancel({ streamId: 'stream-target' });
    await expect(otherStream).resolves.toMatchObject({ action: 'reject' });
    await expect(otherSessionRequest).resolves.toMatchObject({
      action: 'reject',
    });
  });

  it('does not present an approval cancelled during initialization', async () => {
    const { controller } = createApprovalHarness();
    const { approval } = requestApproval(
      controller,
      '/workspace/cancel-initializing.txt',
      'stream-initializing',
    );

    controller.cancel({
      kind: 'toolEdit',
      streamId: 'stream-initializing',
      cause: 'Run ended.',
    });

    await expect(approval).resolves.toMatchObject({
      action: 'reject',
      cause: 'Run ended.',
    });
    expect(vscodeMocks.executeCommand).not.toHaveBeenCalled();
  });

  it('cancels and cleans a selected session approval', async () => {
    const { approval, controller } = await startApproval();

    controller.cancel({
      kind: 'toolEdit',
      streamId: 'stream-approval',
      cause: 'Stream resources released.',
    });

    await expect(approval).resolves.toMatchObject({
      action: 'reject',
      cause: 'Stream resources released.',
    });
  });

  it('reports a failed preview read and accepts a later approval', async () => {
    const { approval, controller, requestId } = await startApproval();
    const proposedUri = currentProposedUri();
    await rm(proposedUri.fsPath);

    controller.handleAction({ requestId, action: 'approve' });

    await vi.waitFor(() =>
      expect(vscodeMocks.showErrorMessage).toHaveBeenCalledOnce(),
    );
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('edited document could not be read'),
    );

    const getText = vi.fn(() => 'beta after retry\r\n');
    vscodeMocks.textDocuments.push({ uri: proposedUri, getText });
    controller.handleAction({ requestId, action: 'approve' });

    await expect(approval).resolves.toMatchObject({
      action: 'apply',
      appliedContent: 'beta after retry\n',
    });
    expect(getText).toHaveBeenCalledOnce();
  });

  it('accepts the current edited document content', async () => {
    const { approval, controller, requestId } = await startApproval();
    const getText = vi.fn(() => 'beta edited\r\n');
    vscodeMocks.textDocuments.push({
      uri: currentProposedUri(),
      getText,
    });

    controller.handleAction({ requestId, action: 'approve' });

    await expect(approval).resolves.toMatchObject({
      action: 'apply',
      appliedContent: 'beta edited\n',
    });
    expect(getText).toHaveBeenCalledOnce();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
  });

  it('previews a non-LaTeX proposal by opening the proposed file', async () => {
    const { approval, controller, requestId } = await startApproval();
    const proposedUri = currentProposedUri();

    controller.handleAction({ requestId, action: 'previewProposed' });

    await vi.waitFor(() =>
      expect(vscodeMocks.showTextDocument).toHaveBeenCalledWith(
        expect.objectContaining({ fsPath: proposedUri.fsPath }),
        { preview: true, preserveFocus: true },
      ),
    );
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();

    controller.handleAction({ requestId, action: 'reject' });
    await expect(approval).resolves.toMatchObject({ action: 'reject' });
  });
});
