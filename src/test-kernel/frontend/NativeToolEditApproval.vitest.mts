import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  approveNativeToolEditApprovals,
  cancelNativeToolEditApprovals,
  handleProgressViewToolEditApprovalAction,
  initializeNativeToolEditApproval,
  nativeRequestApproval,
} from '@frontend/approval/nativeToolEditApproval';
import type { ToolEditPermission } from '@shared/schemas';
import { createTestSession } from '@test/support/sessionTestUtils';
import type { ToolEditApprovalResult } from '@tools/approval/toolEditApproval';
import type * as VSCode from 'vscode';

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
        get: <T,>(_key: string, defaultValue?: T) => defaultValue,
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
  readonly interactions: RecordingRuntimeHost;
  readonly session: SessionHandle;
}

interface StartedApproval extends ApprovalHarness {
  readonly approval: Promise<ToolEditApprovalResult>;
  readonly requestId: string;
}

type ApprovalPrompts = Parameters<typeof initializeNativeToolEditApproval>[2];

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
  initializeNativeToolEditApproval(
    {
      storageUri: { fsPath: storageRoot },
      globalStorageUri: { fsPath: storageRoot },
    } as unknown as VSCode.ExtensionContext,
    interactions,
    prompts(interactions),
  );
  return { interactions, session };
}

function requestApproval(
  session: SessionHandle,
  filePath: string,
  streamId: string,
): Promise<ToolEditApprovalResult> {
  const approval = nativeRequestApproval(
    {
      path: filePath,
      originalContent: 'old\n',
      proposedContent: 'new\n',
      sourceTool: 'write_file',
      streamId,
    },
    { session },
  );
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
  const { interactions, session } = createApprovalHarness();
  const approval = requestApproval(
    session,
    '/workspace/notes.txt',
    'stream-approval',
  );
  return {
    approval,
    requestId: await firstRequestId(interactions),
    interactions,
    session,
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

describe('native tool edit approval', () => {
  it('approves a matching edit while its preview is still initializing', async () => {
    const { interactions, session } = createApprovalHarness();
    const approval = requestApproval(
      session,
      '/workspace/approve-initializing.txt',
      'stream-initializing',
    );

    await expect(
      approveNativeToolEditApprovals(session, 'stream-initializing'),
    ).resolves.toBeUndefined();
    await expect(approval).resolves.toMatchObject({
      accepted: true,
      appliedContent: 'new\n',
    });
    expect(interactions.shown).toEqual([]);
  });

  it('approves a matching edit whose preview is already pending', async () => {
    const { approval, session } = await startApproval();

    await expect(
      approveNativeToolEditApprovals(session, 'stream-approval'),
    ).resolves.toBeUndefined();
    await expect(approval).resolves.toMatchObject({
      accepted: true,
      appliedContent: 'new\n',
    });
  });

  it('keeps pending edit approval scoped to both session and stream', async () => {
    const { interactions, session: targetSession } = createApprovalHarness();
    const otherSession = createTestSession();
    sessions.push(otherSession);
    const target = requestApproval(
      targetSession,
      '/workspace/target.txt',
      'stream-target',
    );
    const otherStream = requestApproval(
      targetSession,
      '/workspace/other-stream.txt',
      'stream-other',
    );
    const otherSessionRequest = requestApproval(
      otherSession,
      '/workspace/other-session.txt',
      'stream-target',
    );
    await vi.waitFor(() => expect(interactions.shown).toHaveLength(3));

    await approveNativeToolEditApprovals(targetSession, 'stream-target');
    await expect(target).resolves.toMatchObject({ accepted: true });

    cancelNativeToolEditApprovals(targetSession, {
      streamId: 'stream-other',
    });
    cancelNativeToolEditApprovals(otherSession, {
      streamId: 'stream-target',
    });
    await expect(otherStream).resolves.toMatchObject({ accepted: false });
    await expect(otherSessionRequest).resolves.toMatchObject({
      accepted: false,
    });
  });

  it('does not present an approval cancelled during initialization', async () => {
    const { interactions, session } = createApprovalHarness();
    const approval = requestApproval(
      session,
      '/workspace/cancel-initializing.txt',
      'stream-initializing',
    );

    cancelNativeToolEditApprovals(session, {
      kind: 'toolEdit',
      streamId: 'stream-initializing',
      cause: 'Run ended.',
    });

    await expect(approval).resolves.toMatchObject({
      accepted: false,
      userMessage: 'Run ended.',
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
    const { interactions, session } = createApprovalHarness();
    const approval = requestApproval(
      session,
      '/workspace/cancel-reveal.txt',
      'stream-reveal',
    );
    await vi.waitFor(() => expect(revealProgress).toBeTypeOf('function'));

    cancelNativeToolEditApprovals(session, {
      kind: 'toolEdit',
      streamId: 'stream-reveal',
      cause: 'Run ended.',
    });
    revealProgress?.();

    await expect(approval).resolves.toMatchObject({ accepted: false });
    await Promise.resolve();
    expect(interactions.shown).toEqual([]);
  });

  it('cancels and cleans a selected session approval', async () => {
    const { approval, requestId, interactions, session } =
      await startApproval();

    cancelNativeToolEditApprovals(session, {
      kind: 'toolEdit',
      streamId: 'stream-approval',
      cause: 'Stream resources released.',
    });

    await expect(approval).resolves.toMatchObject({
      accepted: false,
      userMessage: 'Stream resources released.',
    });
    expect(interactions.resolved).toEqual([{ requestId }]);
  });

  it('isolates host-local prompt failures from the approval result', async () => {
    const { interactions, session } = createApprovalHarness((recorder) => ({
      showToolEditPermission: (payload) => {
        recorder.shown.push(payload);
        throw new Error('show failed');
      },
      resolveToolEditPermission: () => {
        throw new Error('resolve failed');
      },
    }));
    const approval = requestApproval(
      session,
      '/workspace/isolated.txt',
      'stream-isolated',
    );

    await handleProgressViewToolEditApprovalAction({
      requestId: await firstRequestId(interactions),
      action: 'reject',
    });

    await expect(approval).resolves.toMatchObject({ accepted: false });
  });

  it('restores a failed approval prompt and accepts a later retry', async () => {
    const { approval, requestId, interactions } = await startApproval();
    const proposedUri = currentProposedUri();
    await rm(proposedUri.fsPath);

    await handleProgressViewToolEditApprovalAction({
      requestId,
      action: 'approve',
    });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledOnce();
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('edited document could not be read'),
    );
    expect(interactions.resolved).toEqual([{ requestId }]);
    expect(interactions.shown).toHaveLength(2);
    expect(interactions.shown[1]).toEqual(interactions.shown[0]);

    const getText = vi.fn(() => 'beta after retry\r\n');
    vscodeMocks.textDocuments.push({ uri: proposedUri, getText });
    await handleProgressViewToolEditApprovalAction({
      requestId,
      action: 'approve',
    });

    await expect(approval).resolves.toMatchObject({
      accepted: true,
      appliedContent: 'beta after retry\n',
    });
    expect(getText).toHaveBeenCalledOnce();
    expect(interactions.resolved).toEqual([{ requestId }, { requestId }]);
  });

  it('accepts the current edited document content', async () => {
    const { approval, requestId, interactions } = await startApproval();
    const getText = vi.fn(() => 'beta edited\r\n');
    vscodeMocks.textDocuments.push({
      uri: currentProposedUri(),
      getText,
    });

    await handleProgressViewToolEditApprovalAction({
      requestId,
      action: 'approve',
    });

    await expect(approval).resolves.toMatchObject({
      accepted: true,
      appliedContent: 'beta edited\n',
    });
    expect(getText).toHaveBeenCalledOnce();
    expect(vscodeMocks.showErrorMessage).not.toHaveBeenCalled();
    expect(interactions.resolved).toHaveLength(1);
  });
});
