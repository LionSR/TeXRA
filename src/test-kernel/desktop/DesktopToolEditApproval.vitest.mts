// Test support imports

import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestSession as createIsolatedTestSession } from '@test/support/sessionTestUtils';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentRuntimeHost } from '@agent/runtime/AgentRuntimeHost';
import type { RuntimeInteractionEventPayloads } from '@agent/runtime/runtimeInteractionEvents';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent } from '@agent/runtime/SessionEventHub';
import type { DiffOptions, DiffSession, DiffSource } from '@hosts/uiHosts';
import type { ToolEditApprovalAction } from '@shared/schemas/prompts';
import { delay } from '@utils/core';

import { createStubDesktopAgentExecutionHost } from './desktopAgentExecutionTestHarness.mjs';
import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@platform/interfaces';

const approvalTest = (name: string, fn: () => Promise<void>): void => {
  it(name, fn, 30_000);
};

interface DesktopToolEditApprovalModule {
  createDesktopToolEditApprovalController(options: {
    runtimeHost: AgentRuntimeHost;
    session: SessionHandle;
    ui: ReturnType<typeof createStubDesktopAgentExecutionHost>;
    tempRoot?: string;
  }): {
    approvePendingForStream(streamId: string): Promise<void>;
    cancel(selector?: {
      streamId?: string | null;
      kind?: string;
      cause?: string;
    }): void;
    handleAction(payload: {
      requestId: string;
      action: ToolEditApprovalAction;
      feedback?: string;
    }): void;
    requestApproval(
      request: ToolEditApprovalRequest,
    ): Promise<ToolEditApprovalResult>;
    dispose(): void;
  };
}

interface RecordingRuntimeHost extends AgentRuntimeHost {
  shownToolEditPermissions: RuntimeInteractionEventPayloads['showToolEditPermission'][];
  resolvedToolEditPermissions: RuntimeInteractionEventPayloads['resolveToolEditPermission'][];
}

let activeToolEditApproval:
  | ((request: ToolEditApprovalRequest) => Promise<ToolEditApprovalResult>)
  | undefined;
const testSessions: SessionHandle[] = [];

function createTestSession(): SessionHandle {
  const session = createIsolatedTestSession();
  testSessions.push(session);
  return session;
}

function recordSessionEvents(session: SessionHandle): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.events.subscribe((event) => events.push(event), {
    scope: 'session',
  });
  return events;
}

function useControllerApproval(controller: {
  requestApproval(
    request: ToolEditApprovalRequest,
  ): Promise<ToolEditApprovalResult>;
}): void {
  activeToolEditApproval = (request) => controller.requestApproval(request);
}

function createRecordingRuntimeHost(): RecordingRuntimeHost {
  const shownToolEditPermissions: RuntimeInteractionEventPayloads['showToolEditPermission'][] =
    [];
  const resolvedToolEditPermissions: RuntimeInteractionEventPayloads['resolveToolEditPermission'][] =
    [];
  return {
    shownToolEditPermissions,
    resolvedToolEditPermissions,
    emit: (event, payload) => {
      if (event === 'showToolEditPermission') {
        shownToolEditPermissions.push(
          payload as RuntimeInteractionEventPayloads['showToolEditPermission'],
        );
        return;
      }
      if (event === 'resolveToolEditPermission') {
        resolvedToolEditPermissions.push(
          payload as RuntimeInteractionEventPayloads['resolveToolEditPermission'],
        );
      }
    },
  };
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function waitForEmptyDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if ((await readdir(dir)).length === 0) return;
    await delay(10);
  }
}

async function loadApprovalModules(workspacePath = '/workspace') {
  vi.resetModules();
  type MockLocation =
    | { kind: 'workspace'; absolutePath: string; relativePath: string }
    | { kind: 'external'; absolutePath: string };
  const toMockLocation = (filePath: string): MockLocation => {
    if (path.isAbsolute(filePath)) {
      return filePath.startsWith(`${workspacePath}/`)
        ? {
            kind: 'workspace',
            absolutePath: filePath,
            relativePath: filePath.slice(`${workspacePath}/`.length),
          }
        : { kind: 'external', absolutePath: filePath };
    }

    return {
      kind: 'workspace',
      absolutePath: path.join(workspacePath, filePath),
      relativePath: filePath,
    };
  };
  vi.doMock('@utils/config/configUtils', () => ({
    getConfig: vi.fn(() => 'sameDirectory'),
    getValidatedConfig: vi.fn(
      <T,>(_path: string, _schema: unknown, defaultValue: T) => defaultValue,
    ),
  }));
  vi.doMock('@agent/runtime/RunContext', async () => {
    const actual = await vi.importActual<
      typeof import('@agent/runtime/RunContext')
    >('@agent/runtime/RunContext');
    const { createSessionApprovals } = await vi.importActual<
      typeof import('@agent/runtime/streamApprovalQueue')
    >('@agent/runtime/streamApprovalQueue');
    // Session-owned approval state (bypass reads) for the fake run session.
    const approvals = createSessionApprovals();
    return {
      ...actual,
      tryUseRunContext: vi.fn(() =>
        activeToolEditApproval
          ? {
              session: {
                approvals,
                interactions: {
                  requestToolEditApproval: activeToolEditApproval,
                },
              },
            }
          : undefined,
      ),
    };
  });
  vi.doMock('@utils/files', async () => {
    const actual =
      await vi.importActual<typeof import('@utils/files')>('@utils/files');
    return {
      ...actual,
      WorkspaceFS: {
        getPath(): string {
          return workspacePath;
        },
        relativePath(filePath: string): string {
          return filePath.startsWith(`${workspacePath}/`)
            ? filePath.slice(`${workspacePath}/`.length)
            : filePath;
        },
        locatePath(filePath: string): MockLocation {
          return toMockLocation(filePath);
        },
      },
      pathToLocation(filePath: string): MockLocation {
        return toMockLocation(filePath);
      },
    };
  });

  const [{ initPlatform }, { createFakePlatform }, { nodeFilesystem }] =
    await Promise.all([
      import('@platform/platform'),
      import('@test/support/FakePlatform'),
      import('@platform/defaults/nodeFilesystem'),
    ]);
  initPlatform(
    createFakePlatform(
      { workspacePath },
      {
        fs: nodeFilesystem,
      },
    ),
  );

  const [
    { requestToolEditApproval },
    { cleanupApprovalsForStream },
    desktopModule,
  ] = await Promise.all([
    import('@tools/approval/toolEditApproval'),
    import('@tools/approval'),
    import(
      moduleFileUrl(desktopSourcePath('main', 'desktopToolEditApproval.ts'))
    ) as Promise<DesktopToolEditApprovalModule>,
  ]);
  return {
    requestToolEditApproval,
    cleanupApprovalsForStream,
    desktopModule,
  };
}

describe('desktop tool edit approval', () => {
  afterEach(() => {
    activeToolEditApproval = undefined;
    for (const session of testSessions.splice(0)) session.dispose();
    vi.doUnmock('@utils/config/configUtils');
    vi.doUnmock('@agent/runtime/RunContext');
    vi.doUnmock('@tools/approval/latexPreview');
    vi.doUnmock('@utils/files');
    vi.restoreAllMocks();
  });

  approvalTest(
    'approves pending edits only in the selected stream',
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const { desktopModule } = await loadApprovalModules();
      const runtimeHost = createRecordingRuntimeHost();
      const session = createTestSession();
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session,
        ui: createStubDesktopAgentExecutionHost(),
        tempRoot,
      });

      try {
        const target = controller.requestApproval({
          path: '/workspace/target.txt',
          originalContent: 'old target\n',
          proposedContent: 'new target\n',
          sourceTool: 'write_file',
          streamId: 'stream-target',
        });
        const other = controller.requestApproval({
          path: '/workspace/other.txt',
          originalContent: 'old other\n',
          proposedContent: 'new other\n',
          sourceTool: 'write_file',
          streamId: 'stream-other',
        });
        await vi.waitFor(() =>
          expect(runtimeHost.shownToolEditPermissions).toHaveLength(2),
        );

        let targetSettled = false;
        void target.then(() => {
          targetSettled = true;
        });
        await controller.approvePendingForStream('stream-target');
        expect(targetSettled).toBe(true);
        await expect(target).resolves.toMatchObject({
          accepted: true,
          appliedContent: 'new target\n',
        });

        const otherRequest = runtimeHost.shownToolEditPermissions.find(
          (request) => request.streamId === 'stream-other',
        );
        expect(otherRequest).toBeDefined();
        controller.handleAction({
          requestId: otherRequest!.requestId,
          action: 'reject',
        });
        await expect(other).resolves.toMatchObject({ accepted: false });
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  approvalTest(
    'routes proposed-file previews through desktop temp files before rejection',
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const { requestToolEditApproval, desktopModule } =
        await loadApprovalModules();
      const runtimeHost = createRecordingRuntimeHost();
      const emitSpy = vi.spyOn(runtimeHost, 'emit');
      const session = createTestSession();
      const sessionEvents = recordSessionEvents(session);
      const opened: string[] = [];
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session,
        tempRoot,
        ui: createStubDesktopAgentExecutionHost({
          openPath: async (filePath) => {
            opened.push(filePath);
          },
        }),
      });
      useControllerApproval(controller);
      const { shownToolEditPermissions: shown } = runtimeHost;

      try {
        const resultPromise = requestToolEditApproval({
          path: '/workspace/notes.txt',
          originalContent: 'alpha\n',
          proposedContent: 'beta\n',
          sourceTool: 'write_file',
          streamId: 'stream-2',
        });
        await vi.waitFor(() => expect(shown).toHaveLength(1));
        expect(sessionEvents).toContainEqual({
          scope: 'session',
          event: {
            type: 'setActiveStream',
            payload: {
              streamId: 'stream-2',
              suppressViewSwitch: true,
              ensureVisible: true,
            },
          },
        });
        expect(emitSpy).toHaveBeenCalledWith('requestEnsureProgressView', {});
        expect(shown[0]).toMatchObject({
          path: '/workspace/notes.txt',
          relativePath: 'notes.txt',
          sourceTool: 'write_file',
          streamId: 'stream-2',
        });

        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'previewProposed',
        });
        await vi.waitFor(() => expect(opened).toHaveLength(1));
        expect(path.basename(opened[0])).toContain('proposed');
        await expect(pathExists(opened[0])).resolves.toBe(true);

        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'reject',
          feedback: 'not yet',
        });
        await expect(resultPromise).resolves.toMatchObject({
          accepted: false,
          userMessage: 'not yet',
        });
        await vi.waitFor(async () => {
          await expect(pathExists(opened[0])).resolves.toBe(false);
        });
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  approvalTest(
    'routes diff actions through the required desktop diff host',
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const { requestToolEditApproval, desktopModule } =
        await loadApprovalModules();
      const runtimeHost = createRecordingRuntimeHost();
      const openPath = vi.fn(async (_filePath: string) => {});
      const openDiff = vi.fn(
        async (
          original: DiffSource,
          proposed: DiffSource,
          title: string,
          _options?: DiffOptions,
        ): Promise<DiffSession> => ({ original, proposed, title }),
      );
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session: createTestSession(),
        tempRoot,
        ui: createStubDesktopAgentExecutionHost({ openPath, openDiff }),
      });
      useControllerApproval(controller);
      const { shownToolEditPermissions: shown } = runtimeHost;

      try {
        const resultPromise = requestToolEditApproval({
          path: '/workspace/main.tex',
          originalContent: 'old\n',
          proposedContent: 'new\n',
          sourceTool: 'write_file',
        });
        await vi.waitFor(() => expect(shown).toHaveLength(1));

        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'openDiff',
        });

        await vi.waitFor(() => expect(openDiff).toHaveBeenCalledOnce());
        expect(openPath).not.toHaveBeenCalled();
        const [original, proposed, title, options] = openDiff.mock.calls[0];
        expect(title).toBe('Tool edit: main.tex');
        expect(options).toEqual({ preserveFocus: true });
        await expect(pathExists(original.filePath)).resolves.toBe(true);
        await expect(pathExists(proposed.filePath)).resolves.toBe(true);

        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'reject',
        });
        await expect(resultPromise).resolves.toMatchObject({ accepted: false });
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  approvalTest(
    'applies user edits made in the proposed preview file',
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const { requestToolEditApproval, desktopModule } =
        await loadApprovalModules();
      const runtimeHost = createRecordingRuntimeHost();
      const opened: string[] = [];
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session: createTestSession(),
        tempRoot,
        ui: createStubDesktopAgentExecutionHost({
          openPath: async (filePath) => {
            opened.push(filePath);
          },
        }),
      });
      useControllerApproval(controller);
      const { shownToolEditPermissions: shown } = runtimeHost;

      try {
        const resultPromise = requestToolEditApproval({
          path: '/workspace/notes.txt',
          originalContent: 'alpha\n',
          proposedContent: 'beta\n',
          sourceTool: 'write_file',
          streamId: 'stream-edited-preview',
        });
        await vi.waitFor(() => expect(shown).toHaveLength(1));

        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'previewProposed',
        });
        await vi.waitFor(() => expect(opened).toHaveLength(1));
        await writeFile(opened[0], 'beta\nwith user edits\nand more\n', 'utf8');

        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'approve',
        });

        await expect(resultPromise).resolves.toMatchObject({
          accepted: true,
          appliedContent: 'beta\nwith user edits\nand more\n',
          lineChanges: { added: 3, removed: 1 },
        });
        await vi.waitFor(async () => {
          await expect(pathExists(opened[0])).resolves.toBe(false);
        });
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  approvalTest(
    'routes LaTeX diff inspection without settling the request',
    async () => {
      const runLatexdiff = vi.fn(async () => {});
      vi.doMock('@tools/approval/latexPreview', async () => {
        const actual = await vi.importActual<
          typeof import('@tools/approval/latexPreview')
        >('@tools/approval/latexPreview');
        return { ...actual, runLatexdiff };
      });

      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const { requestToolEditApproval, desktopModule } =
        await loadApprovalModules();
      const runtimeHost = createRecordingRuntimeHost();
      const openBuildDisplay = vi.fn(async () => {});
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session: createTestSession(),
        tempRoot,
        ui: createStubDesktopAgentExecutionHost({ openBuildDisplay }),
      });
      useControllerApproval(controller);
      const { shownToolEditPermissions: shown } = runtimeHost;

      try {
        const resultPromise = requestToolEditApproval({
          path: '/workspace/main.tex',
          originalContent: 'old\n',
          proposedContent: 'new\n',
          sourceTool: 'write_file',
        });
        await vi.waitFor(() => expect(shown).toHaveLength(1));
        let settled = false;
        void resultPromise.then(() => {
          settled = true;
        });

        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'showLatexdiff',
        });

        await vi.waitFor(() => expect(runLatexdiff).toHaveBeenCalledOnce());
        expect(runLatexdiff).toHaveBeenCalledWith(
          expect.objectContaining({ requestId: shown[0].requestId }),
          {
            subtype: 'ONLYCHANGEDPAGE',
            openBuildDisplay,
          },
        );
        expect(settled).toBe(false);

        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'reject',
        });
        await expect(resultPromise).resolves.toMatchObject({ accepted: false });
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  approvalTest(
    'uses the injected desktop build display callback for LaTeX preview',
    async () => {
      const workspaceRoot = await mkdtemp(
        path.join(tmpdir(), 'texra-workspace-'),
      );
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const { requestToolEditApproval, desktopModule } =
        await loadApprovalModules(workspaceRoot);
      const runtimeHost = createRecordingRuntimeHost();
      const displayed: Array<{
        absolutePath: string;
        options?: { preserveFocus?: boolean };
      }> = [];
      const messages: string[] = [];
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session: createTestSession(),
        tempRoot,
        ui: createStubDesktopAgentExecutionHost({
          openBuildDisplay: async (location, options) => {
            displayed.push({ absolutePath: location.absolutePath, options });
          },
          showErrorMessage: (message) => {
            messages.push(message);
          },
        }),
      });
      useControllerApproval(controller);
      const { shownToolEditPermissions: shown } = runtimeHost;

      try {
        const resultPromise = requestToolEditApproval({
          path: path.join(workspaceRoot, 'main.tex'),
          originalContent:
            '\\documentclass{article}\\begin{document}old\\end{document}\n',
          proposedContent:
            '\\documentclass{article}\\begin{document}new\\end{document}\n',
          sourceTool: 'write_file',
        });
        await vi.waitFor(() => expect(shown).toHaveLength(1));

        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'previewProposed',
        });

        await vi.waitFor(() => {
          expect([...displayed, ...messages]).toHaveLength(1);
        });
        expect(messages).toEqual([]);
        expect(displayed[0].options).toEqual({ preserveFocus: true });
        expect(path.basename(displayed[0].absolutePath)).toMatch(
          /^main_preview-[\w-]{8}\.tex$/,
        );
        await expect(pathExists(displayed[0].absolutePath)).resolves.toBe(true);

        controller.dispose();
        await expect(resultPromise).resolves.toMatchObject({ accepted: false });
        await vi.waitFor(async () => {
          await expect(pathExists(displayed[0].absolutePath)).resolves.toBe(
            false,
          );
        });
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
        await rm(workspaceRoot, { recursive: true, force: true });
      }
    },
  );

  approvalTest(
    'does not present a stream approval cancelled during initialization',
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const { requestToolEditApproval, desktopModule } =
        await loadApprovalModules();
      const runtimeHost = createRecordingRuntimeHost();
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session: createTestSession(),
        ui: createStubDesktopAgentExecutionHost(),
        tempRoot,
      });
      useControllerApproval(controller);

      try {
        const resultPromise = requestToolEditApproval({
          path: '/workspace/cancel-during-init.tex',
          originalContent: 'old\n',
          proposedContent: 'new\n',
          sourceTool: 'write_file',
          streamId: 'stream-cancel-during-init',
        });
        controller.cancel({
          kind: 'toolEdit',
          streamId: 'stream-cancel-during-init',
          cause: 'Owning execution ended.',
        });

        await expect(resultPromise).resolves.toMatchObject({
          accepted: false,
          userMessage: 'Owning execution ended.',
        });
        expect(runtimeHost.shownToolEditPermissions).toEqual([]);
        expect(runtimeHost.resolvedToolEditPermissions).toEqual([]);
        await waitForEmptyDir(tempRoot);
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  approvalTest(
    'does not present an approval when disposed during initialization',
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const { requestToolEditApproval, desktopModule } =
        await loadApprovalModules();
      const runtimeHost = createRecordingRuntimeHost();
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session: createTestSession(),
        ui: createStubDesktopAgentExecutionHost(),
        tempRoot,
      });
      useControllerApproval(controller);

      try {
        const resultPromise = requestToolEditApproval({
          path: '/workspace/dispose-during-init.tex',
          originalContent: 'old\n',
          proposedContent: 'new\n',
          sourceTool: 'write_file',
          streamId: 'stream-dispose-during-init',
        });
        controller.dispose();

        await expect(resultPromise).resolves.toMatchObject({
          accepted: false,
          userMessage: 'Desktop session disposed.',
        });
        expect(runtimeHost.shownToolEditPermissions).toEqual([]);
        expect(runtimeHost.resolvedToolEditPermissions).toEqual([]);
        await waitForEmptyDir(tempRoot);
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  approvalTest(
    'cancels only tool-edit approvals selected for the owning stream',
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const { requestToolEditApproval, desktopModule } =
        await loadApprovalModules();
      const runtimeHost = createRecordingRuntimeHost();
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session: createTestSession(),
        ui: createStubDesktopAgentExecutionHost(),
        tempRoot,
      });
      useControllerApproval(controller);
      const { shownToolEditPermissions: shown } = runtimeHost;
      const { resolvedToolEditPermissions: resolved } = runtimeHost;

      try {
        const cancelledPromise = requestToolEditApproval({
          path: '/workspace/cancelled.tex',
          originalContent: 'old\n',
          proposedContent: 'new\n',
          sourceTool: 'write_file',
          streamId: 'stream-cancelled',
        });
        const retainedPromise = requestToolEditApproval({
          path: '/workspace/retained.tex',
          originalContent: 'old\n',
          proposedContent: 'new\n',
          sourceTool: 'write_file',
          streamId: 'stream-retained',
        });
        await vi.waitFor(() => expect(shown).toHaveLength(2));
        const cancelledRequest = shown.find(
          (request) => request.streamId === 'stream-cancelled',
        );
        const retainedRequest = shown.find(
          (request) => request.streamId === 'stream-retained',
        );
        if (!cancelledRequest || !retainedRequest) {
          throw new Error('Expected both stream-scoped approval prompts.');
        }

        controller.cancel({
          kind: 'toolEdit',
          streamId: 'stream-cancelled',
          cause: 'Owning execution ended.',
        });

        await expect(cancelledPromise).resolves.toMatchObject({
          accepted: false,
          userMessage: 'Owning execution ended.',
        });
        expect(resolved).toEqual([{ requestId: cancelledRequest.requestId }]);

        controller.handleAction({
          requestId: retainedRequest.requestId,
          action: 'reject',
          feedback: 'Retained request resolved normally.',
        });
        await expect(retainedPromise).resolves.toMatchObject({
          accepted: false,
          userMessage: 'Retained request resolved normally.',
        });
        await waitForEmptyDir(tempRoot);
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );

  approvalTest(
    'cleans pending entries and temp files when stream cleanup rejects a request',
    async () => {
      const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
      const {
        requestToolEditApproval,
        cleanupApprovalsForStream,
        desktopModule,
      } = await loadApprovalModules();
      const runtimeHost = createRecordingRuntimeHost();
      const session = createTestSession();
      const controller = desktopModule.createDesktopToolEditApprovalController({
        runtimeHost,
        session,
        ui: createStubDesktopAgentExecutionHost(),
        tempRoot,
      });
      useControllerApproval(controller);
      const { shownToolEditPermissions: shown } = runtimeHost;
      const { resolvedToolEditPermissions: resolved } = runtimeHost;

      try {
        const resultPromise = requestToolEditApproval({
          path: '/workspace/cleanup.tex',
          originalContent: 'old\n',
          proposedContent: 'new\n',
          sourceTool: 'write_file',
          streamId: 'stream-cleanup',
        });
        await vi.waitFor(() => expect(shown).toHaveLength(1));

        // Pending registries are session-owned: sweep the owning session.
        cleanupApprovalsForStream('stream-cleanup', session);

        await expect(resultPromise).resolves.toMatchObject({ accepted: false });
        expect(resolved).toEqual([{ requestId: shown[0].requestId }]);
        await waitForEmptyDir(tempRoot);
        expect(await readdir(tempRoot)).toEqual([]);
      } finally {
        controller.dispose();
        await rm(tempRoot, { recursive: true, force: true });
      }
    },
  );
});
