import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  ToolEditApprovalController,
  type ToolEditApprovalControllerOptions,
} from '@controllers/approval/ToolEditApprovalController';
import { VscodeToolEditApprovalHost } from '@frontend/approval/VscodeToolEditApprovalHost';
import type { ToolEditPermission } from '@shared/schemas';
import { SESSION_DISPOSED_CAUSE } from '@shared/copy/interactionCancellation';
import { createTestSession } from '@test/support/sessionTestUtils';
import type { ToolEditApprovalResult } from '@tools/approval/toolEditApproval';

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

interface RecordingRuntimeHost extends Pick<SessionHostInteractions, 'emit'> {
  readonly shown: ToolEditPermission[];
  readonly resolved: Array<{ requestId: string }>;
}

interface ApprovalHarness {
  readonly controller: ToolEditApprovalController;
  readonly interactions: RecordingRuntimeHost;
  readonly session: SessionHandle;
}

interface StartedApproval extends ApprovalHarness {
  readonly approval: Promise<ToolEditApprovalResult>;
  readonly requestId: string;
}

type ApprovalPrompts = Pick<
  ToolEditApprovalControllerOptions,
  'showToolEditPermission' | 'resolveToolEditPermission'
>;

const sessions: SessionHandle[] = [];
const activeApprovals: Promise<ToolEditApprovalResult>[] = [];
let storageRoot: string;

function recordingPrompts(interactions: RecordingRuntimeHost): ApprovalPrompts {
  return {
    showToolEditPermission: (payload) => interactions.shown.push(payload),
    resolveToolEditPermission: (requestId) =>
      interactions.resolved.push({ requestId }),
  };
}

/** One controller per session, exactly as `ProgressViewProvider` wires it. */
function createApprovalHarness(
  prompts: (
    interactions: RecordingRuntimeHost,
  ) => ApprovalPrompts = recordingPrompts,
): ApprovalHarness {
  const interactions: RecordingRuntimeHost = {
    shown: [],
    resolved: [],
    emit: vi.fn(),
  };
  const session = createTestSession();
  sessions.push(session);
  const controller = new ToolEditApprovalController({
    interactions,
    session,
    host: new VscodeToolEditApprovalHost(storageRoot),
    ...prompts(interactions),
    detachCause: SESSION_DISPOSED_CAUSE,
  });
  return { controller, interactions, session };
}

function requestApproval(
  controller: ToolEditApprovalController,
  filePath: string,
  streamId: string,
): Promise<ToolEditApprovalResult> {
  const approval = controller.requestApproval({
    path: filePath,
    originalContent: 'old\n',
    proposedContent: 'new\n',
    sourceTool: 'write_file',
    streamId,
  });
  activeApprovals.push(approval);
  return approval;
}

async function firstRequestId(
  interactions: RecordingRuntimeHost,
): Promise<string> {
  await vi.waitFor(() => expect(interactions.shown).toHaveLength(1));
  const requestId = interactions.shown[0]?.requestId;
  if (!requestId) {
    throw new Error('Expected a tool edit approval request ID.');
  }
  return requestId;
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
  const approval = requestApproval(
    harness.controller,
    '/workspace/notes.txt',
    'stream-approval',
  );
  return {
    ...harness,
    approval,
    requestId: await firstRequestId(harness.interactions),
  };
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
  storageRoot = await mkdtemp(path.join(tmpdir(), 'texra-native-approval-'));
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    session.dispose();
  }
  await Promise.allSettled(activeApprovals.splice(0));
  await rm(storageRoot, { recursive: true, force: true });
});

describe('VS Code tool edit approval', () => {
  it('approves a matching edit while its preview is still initializing', async () => {
    const { controller, interactions } = createApprovalHarness();
    const approval = requestApproval(
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
    expect(interactions.shown).toEqual([]);
  });

  it('publishes line changes derived from the request content', async () => {
    const { approval, controller, requestId, interactions } =
      await startApproval();

    expect(interactions.shown[0]).toMatchObject({
      requestId,
      path: '/workspace/notes.txt',
      relativePath: 'notes.txt',
      sourceTool: 'write_file',
      streamId: 'stream-approval',
      addedLines: 1,
      removedLines: 1,
      isLatex: false,
    });

    controller.handleAction({ requestId, action: 'reject' });
    await expect(approval).resolves.toMatchObject({ action: 'reject' });
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
    const targetStream = requestApproval(
      target.controller,
      '/workspace/target.txt',
      'stream-target',
    );
    const otherStream = requestApproval(
      target.controller,
      '/workspace/other-stream.txt',
      'stream-other',
    );
    const otherSessionRequest = requestApproval(
      other.controller,
      '/workspace/other-session.txt',
      'stream-target',
    );
    await vi.waitFor(() => expect(target.interactions.shown).toHaveLength(2));
    await vi.waitFor(() => expect(other.interactions.shown).toHaveLength(1));

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
    const { controller, interactions } = createApprovalHarness();
    const approval = requestApproval(
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
    expect(interactions.shown).toEqual([]);
  });

  it('does not publish a prompt after cancellation while revealing the view', async () => {
    let revealProgress: (() => void) | undefined;
    vscodeMocks.executeCommand.mockImplementation(
      async (command: unknown, ...args: unknown[]) => {
        recordDiffEditor(command, args);
        if (command === 'texra.showProgressView') {
          await new Promise<void>((resolve) => {
            revealProgress = resolve;
          });
        }
      },
    );
    const { controller, interactions } = createApprovalHarness();
    const approval = requestApproval(
      controller,
      '/workspace/cancel-reveal.txt',
      'stream-reveal',
    );
    await vi.waitFor(() => expect(revealProgress).toBeTypeOf('function'));

    controller.cancel({
      kind: 'toolEdit',
      streamId: 'stream-reveal',
      cause: 'Run ended.',
    });
    revealProgress?.();

    await expect(approval).resolves.toMatchObject({ action: 'reject' });
    await Promise.resolve();
    expect(interactions.shown).toEqual([]);
  });

  it('cancels and cleans a selected session approval', async () => {
    const { approval, controller, requestId, interactions } =
      await startApproval();

    controller.cancel({
      kind: 'toolEdit',
      streamId: 'stream-approval',
      cause: 'Stream resources released.',
    });

    await expect(approval).resolves.toMatchObject({
      action: 'reject',
      cause: 'Stream resources released.',
    });
    expect(interactions.resolved).toEqual([{ requestId }]);
  });

  it('isolates host-local prompt failures from the approval result', async () => {
    const { controller, interactions } = createApprovalHarness((recorder) => ({
      showToolEditPermission: (payload) => {
        recorder.shown.push(payload);
        throw new Error('show failed');
      },
      resolveToolEditPermission: () => {
        throw new Error('resolve failed');
      },
    }));
    const approval = requestApproval(
      controller,
      '/workspace/isolated.txt',
      'stream-isolated',
    );

    controller.handleAction({
      requestId: await firstRequestId(interactions),
      action: 'reject',
    });

    await expect(approval).resolves.toMatchObject({ action: 'reject' });
  });

  it('restores a failed approval prompt and accepts a later retry', async () => {
    const { approval, controller, requestId, interactions } =
      await startApproval();
    const proposedUri = currentProposedUri();
    await rm(proposedUri.fsPath);

    controller.handleAction({ requestId, action: 'approve' });

    await vi.waitFor(() => expect(interactions.shown).toHaveLength(2));
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledOnce();
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('edited document could not be read'),
    );
    expect(interactions.resolved).toEqual([{ requestId }]);
    expect(interactions.shown[1]).toEqual(interactions.shown[0]);

    const getText = vi.fn(() => 'beta after retry\r\n');
    vscodeMocks.textDocuments.push({ uri: proposedUri, getText });
    controller.handleAction({ requestId, action: 'approve' });

    await expect(approval).resolves.toMatchObject({
      action: 'apply',
      appliedContent: 'beta after retry\n',
    });
    expect(getText).toHaveBeenCalledOnce();
    expect(interactions.resolved).toEqual([{ requestId }, { requestId }]);
  });

  it('accepts the current edited document content', async () => {
    const { approval, controller, requestId, interactions } =
      await startApproval();
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
    expect(interactions.resolved).toHaveLength(1);
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
