import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import {
  handleProgressViewToolEditApprovalAction,
  initializeNativeToolEditApproval,
  nativeRequestApproval,
} from '@frontend/approval/nativeToolEditApproval';
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

interface RecordingRuntimeHost extends AgentRuntimeHost {
  readonly shown: RuntimeInteractionEventPayloads['showToolEditPermission'][];
  readonly resolved: RuntimeInteractionEventPayloads['resolveToolEditPermission'][];
}

interface StartedApproval {
  readonly approval: Promise<ToolEditApprovalResult>;
  readonly requestId: string;
  readonly runtimeHost: RecordingRuntimeHost;
}

const sessions: SessionHandle[] = [];
const activeApprovals: Promise<ToolEditApprovalResult>[] = [];
let storageRoot: string;

function createRecordingRuntimeHost(): RecordingRuntimeHost {
  const shown: RuntimeInteractionEventPayloads['showToolEditPermission'][] = [];
  const resolved: RuntimeInteractionEventPayloads['resolveToolEditPermission'][] =
    [];
  return {
    shown,
    resolved,
    emit: (event, payload) => {
      if (event === 'showToolEditPermission') {
        shown.push(
          payload as RuntimeInteractionEventPayloads['showToolEditPermission'],
        );
      } else if (event === 'resolveToolEditPermission') {
        resolved.push(
          payload as RuntimeInteractionEventPayloads['resolveToolEditPermission'],
        );
      }
    },
  };
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
  const runtimeHost = createRecordingRuntimeHost();
  const session = new SessionHandle();
  sessions.push(session);
  initializeNativeToolEditApproval(
    {
      storageUri: { fsPath: storageRoot },
      globalStorageUri: { fsPath: storageRoot },
    } as unknown as VSCode.ExtensionContext,
    runtimeHost,
  );

  const approval = nativeRequestApproval(
    {
      path: '/workspace/notes.txt',
      originalContent: 'alpha\n',
      proposedContent: 'beta\n',
      sourceTool: 'write_file',
      streamId: 'stream-approval',
    },
    { session },
  );
  activeApprovals.push(approval);

  await vi.waitFor(() => expect(runtimeHost.shown).toHaveLength(1));
  const requestId = runtimeHost.shown[0]?.requestId;
  if (!requestId) {
    throw new Error('Expected a tool edit approval request ID.');
  }
  return { approval, requestId, runtimeHost };
}

beforeEach(async () => {
  vi.clearAllMocks();
  vscodeMocks.textDocuments.splice(0);
  vscodeMocks.visibleTextEditors.splice(0);
  vscodeMocks.executeCommand.mockImplementation(
    async (command: unknown, ...args: unknown[]) => {
      if (command === 'vscode.diff') {
        const proposedUri = args[1] as TestUri;
        vscodeMocks.visibleTextEditors.push({
          document: { uri: proposedUri },
          selections: [],
          revealRange: vi.fn(),
        });
      }
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
  it('does not accept when the current proposed document cannot be read', async () => {
    const { approval, requestId, runtimeHost } = await startApproval();
    await rm(currentProposedUri().fsPath);

    await handleProgressViewToolEditApprovalAction({
      requestId,
      action: 'approve',
    });

    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledOnce();
    expect(vscodeMocks.showErrorMessage).toHaveBeenCalledWith(
      expect.stringContaining('edited document could not be read'),
    );
    expect(runtimeHost.resolved).toHaveLength(0);

    await handleProgressViewToolEditApprovalAction({
      requestId,
      action: 'reject',
    });
    await expect(approval).resolves.toMatchObject({ accepted: false });
  });

  it('accepts the current edited document content', async () => {
    const { approval, requestId, runtimeHost } = await startApproval();
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
    expect(runtimeHost.resolved).toHaveLength(1);
  });
});
