import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import { SessionHandle } from '@agent/runtime/SessionHandle';
import type { SessionEvent } from '@agent/runtime/SessionEventHub';
import type { DesktopAgentExecutionHost } from '@desktop/main/desktopAgentExecutionHost';
import type { DiffOptions, DiffSession, DiffSource } from '@hosts/uiHosts';

import type { ToolEditPermission } from '@shared/schemas';
import { SESSION_DISPOSED_CAUSE } from '@shared/copy/interactionCancellation';
import { createModuleMocks } from '@test/support/moduleMocks';
import { createTestSession } from '@test/support/sessionTestUtils';
import type {
  ToolEditApprovalRequest,
  ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import {
  createStubDesktopAgentExecutionHost,
  disposeAfterTest,
} from './desktopAgentExecutionTestHarness.ts';
import { loadSourceModule } from './loadSourceModule.ts';

const approvalTest = (name: string, fn: () => Promise<void>): void => {
  it(name, fn, 30_000);
};

type ApprovalModules = Awaited<ReturnType<typeof loadApprovalModules>>;
type ApprovalController = InstanceType<
  ApprovalModules['controllerModule']['ToolEditApprovalController']
>;

interface ApprovalControllerOptions {
  interactions: RecordingRuntimeHost;
  session: SessionHandle;
  ui: DesktopAgentExecutionHost;
  tempRoot: string;
  showToolEditPermission(payload: ToolEditPermission): void;
  resolveToolEditPermission(requestId: string): void;
}

interface RecordingRuntimeHost extends Pick<SessionHostInteractions, 'emit'> {
  shownToolEditPermissions: ToolEditPermission[];
  resolvedToolEditPermissions: Array<{ requestId: string }>;
}

/**
 * The approval handler a loaded module registry routes `tryUseRunContext` to.
 * One holder per `loadApprovalModules` call, so a test only ever reaches the
 * controller its own fixture registered.
 */
interface ActiveApproval {
  requestApproval?: (
    request: ToolEditApprovalRequest,
  ) => Promise<ToolEditApprovalResult>;
}

const mocks = createModuleMocks();

/** Controllers are disposed after each test; `dispose` is idempotent. */
function createApprovalController(
  modules: Pick<ApprovalModules, 'controllerModule' | 'desktopModule'>,
  options: ApprovalControllerOptions,
): ApprovalController {
  const controller = new modules.controllerModule.ToolEditApprovalController({
    interactions: options.interactions,
    session: options.session,
    host: new modules.desktopModule.DesktopToolEditApprovalHost({
      ui: options.ui,
      tempRoot: options.tempRoot,
    }),
    showToolEditPermission: options.showToolEditPermission,
    resolveToolEditPermission: options.resolveToolEditPermission,
    detachCause: SESSION_DISPOSED_CAUSE,
  });
  return disposeAfterTest(controller);
}

async function createTempRoot(prefix = 'texra-approval-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function recordSessionEvents(session: SessionHandle): SessionEvent[] {
  const events: SessionEvent[] = [];
  session.events.subscribe((event) => events.push(event), {
    scope: 'session',
  });
  return events;
}

function createRecordingRuntimeHost(): RecordingRuntimeHost {
  return {
    shownToolEditPermissions: [],
    resolvedToolEditPermissions: [],
    emit: vi.fn(),
  };
}

function controllerHostCallbacks(interactions: RecordingRuntimeHost): {
  showToolEditPermission(payload: ToolEditPermission): void;
  resolveToolEditPermission(requestId: string): void;
} {
  return {
    showToolEditPermission: (payload) =>
      interactions.shownToolEditPermissions.push(payload),
    resolveToolEditPermission: (requestId) =>
      interactions.resolvedToolEditPermissions.push({ requestId }),
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

/** Polls until `dir` is empty; fails the test if cleanup never completes. */
async function waitForEmptyDir(dir: string): Promise<void> {
  await vi.waitFor(async () => {
    expect(await readdir(dir)).toEqual([]);
  });
}

async function loadApprovalModules(workspacePath = '/workspace') {
  vi.resetModules();
  const activeApproval: ActiveApproval = {};
  type MockLocation =
    | { kind: 'workspace'; absolutePath: string; relativePath: string }
    | { kind: 'external'; absolutePath: string };
  const toMockLocation = (filePath: string): MockLocation => {
    if (!path.isAbsolute(filePath)) {
      return {
        kind: 'workspace',
        absolutePath: path.join(workspacePath, filePath),
        relativePath: filePath,
      };
    }
    if (filePath.startsWith(`${workspacePath}/`)) {
      return {
        kind: 'workspace',
        absolutePath: filePath,
        relativePath: filePath.slice(`${workspacePath}/`.length),
      };
    }
    return { kind: 'external', absolutePath: filePath };
  };
  mocks.doMock('@utils/config/configUtils', () => ({
    getConfig: vi.fn(() => 'sameDirectory'),
    getConfigBeforePlatformInit: vi.fn(
      <T>(_path: string, defaultValue: T) => defaultValue,
    ),
    getValidatedConfig: vi.fn(
      <T>(_path: string, _schema: unknown, defaultValue: T) => defaultValue,
    ),
  }));
  mocks.doMock('@agent/runtime/RunContext', async () => {
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
        activeApproval.requestApproval
          ? {
              session: {
                approvals,
                interactions: {
                  requestToolEditApproval: activeApproval.requestApproval,
                },
              },
            }
          : undefined,
      ),
    };
  });
  mocks.doMock('@utils/files/workspaceFS', async () => {
    const actual = await vi.importActual<
      typeof import('@utils/files/workspaceFS')
    >('@utils/files/workspaceFS');
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
    controllerModule,
    desktopModule,
  ] = await Promise.all([
    import('@tools/approval/toolEditApproval'),
    import('@tools/approval'),
    import('@controllers/approval/ToolEditApprovalController'),
    loadSourceModule('@desktop/main/desktopToolEditApproval'),
  ]);
  return {
    activeApproval,
    requestToolEditApproval,
    cleanupApprovalsForStream,
    controllerModule,
    desktopModule,
  };
}

/**
 * Standard approval wiring: a fresh temp root, recording interactions, an
 * isolated session, and a controller registered as the active approval handler.
 */
async function createApprovalFixture(
  options: {
    ui?: DesktopAgentExecutionHost;
    workspacePath?: string;
    callbacks?: Partial<ReturnType<typeof controllerHostCallbacks>>;
  } = {},
): Promise<
  ApprovalModules & {
    controller: ApprovalController;
    interactions: RecordingRuntimeHost;
    session: SessionHandle;
    tempRoot: string;
  }
> {
  const tempRoot = await createTempRoot();
  const modules = await loadApprovalModules(options.workspacePath);
  const interactions = createRecordingRuntimeHost();
  const session = disposeAfterTest(createTestSession());
  const controller = createApprovalController(modules, {
    interactions,
    ...controllerHostCallbacks(interactions),
    ...options.callbacks,
    session,
    ui: options.ui ?? createStubDesktopAgentExecutionHost(),
    tempRoot,
  });
  modules.activeApproval.requestApproval = (request) =>
    controller.requestApproval(request);
  return { ...modules, controller, interactions, session, tempRoot };
}

describe('desktop tool edit approval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  approvalTest(
    'approves pending edits only in the selected stream',
    async () => {
      const { controller, interactions } = await createApprovalFixture();

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
        expect(interactions.shownToolEditPermissions).toHaveLength(2),
      );

      let targetSettled = false;
      void target.then(() => {
        targetSettled = true;
      });
      await controller.approvePendingForStream('stream-target');
      await expect(target).resolves.toMatchObject({
        action: 'apply',
        appliedContent: 'new target\n',
      });
      expect(targetSettled).toBe(true);

      const otherRequest = interactions.shownToolEditPermissions.find(
        (request) => request.streamId === 'stream-other',
      );
      expect(otherRequest).toBeDefined();
      controller.handleAction({
        requestId: otherRequest!.requestId,
        action: 'reject',
      });
      await expect(other).resolves.toMatchObject({ action: 'reject' });
    },
  );

  approvalTest(
    'isolates host-local prompt failures from the approval result',
    async () => {
      let shown: ToolEditPermission | undefined;
      const { controller } = await createApprovalFixture({
        callbacks: {
          showToolEditPermission: (payload) => {
            shown = payload;
            throw new Error('show failed');
          },
          resolveToolEditPermission: () => {
            throw new Error('resolve failed');
          },
        },
      });

      const approval = controller.requestApproval({
        path: '/workspace/isolated.txt',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'write_file',
        streamId: 'stream-isolated',
      });
      await vi.waitFor(() => expect(shown).toBeDefined());

      controller.handleAction({
        requestId: shown!.requestId,
        action: 'reject',
      });

      await expect(approval).resolves.toMatchObject({ action: 'reject' });
    },
  );

  approvalTest(
    'routes proposed-file previews through desktop temp files before rejection',
    async () => {
      const opened: string[] = [];
      const { requestToolEditApproval, controller, interactions, session } =
        await createApprovalFixture({
          ui: createStubDesktopAgentExecutionHost({
            openPath: async (filePath) => {
              opened.push(filePath);
            },
          }),
        });
      const emitSpy = vi.spyOn(interactions, 'emit');
      const sessionEvents = recordSessionEvents(session);
      const { shownToolEditPermissions: shown } = interactions;

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
        addedLines: 1,
        removedLines: 1,
        isLatex: false,
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
        action: 'reject',
        feedback: 'not yet',
      });
      await vi.waitFor(async () => {
        await expect(pathExists(opened[0])).resolves.toBe(false);
      });
    },
  );

  approvalTest(
    'routes diff actions through the required desktop diff host',
    async () => {
      const openPath = vi.fn(async (_filePath: string) => {});
      const openDiff = vi.fn(
        async (
          original: DiffSource,
          proposed: DiffSource,
          title: string,
          _options?: DiffOptions,
        ): Promise<DiffSession> => ({ original, proposed, title }),
      );
      const { requestToolEditApproval, controller, interactions } =
        await createApprovalFixture({
          ui: createStubDesktopAgentExecutionHost({ openPath, openDiff }),
        });
      const { shownToolEditPermissions: shown } = interactions;

      const resultPromise = requestToolEditApproval({
        path: '/workspace/main.tex',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'write_file',
      });
      await vi.waitFor(() => expect(shown).toHaveLength(1));
      await vi.waitFor(() => expect(openDiff).toHaveBeenCalledOnce());

      controller.handleAction({
        requestId: shown[0].requestId,
        action: 'openDiff',
      });

      await vi.waitFor(() => expect(openDiff).toHaveBeenCalledTimes(2));
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
      await expect(resultPromise).resolves.toMatchObject({ action: 'reject' });
    },
  );

  approvalTest(
    'applies user edits made in the proposed preview file',
    async () => {
      const opened: string[] = [];
      const { requestToolEditApproval, controller, interactions } =
        await createApprovalFixture({
          ui: createStubDesktopAgentExecutionHost({
            openPath: async (filePath) => {
              opened.push(filePath);
            },
          }),
        });
      const { shownToolEditPermissions: shown } = interactions;

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
        action: 'apply',
        appliedContent: 'beta\nwith user edits\nand more\n',
        lineChanges: { added: 3, removed: 1 },
      });
      await vi.waitFor(async () => {
        await expect(pathExists(opened[0])).resolves.toBe(false);
      });
    },
  );

  approvalTest(
    'restores a failed approval prompt and accepts a later retry',
    async () => {
      const opened: string[] = [];
      const messages: string[] = [];
      const { requestToolEditApproval, controller, interactions } =
        await createApprovalFixture({
          ui: createStubDesktopAgentExecutionHost({
            openPath: async (filePath) => {
              opened.push(filePath);
            },
            showErrorMessage: (message) => {
              messages.push(message);
            },
          }),
        });
      const {
        shownToolEditPermissions: shown,
        resolvedToolEditPermissions: resolved,
      } = interactions;

      const resultPromise = requestToolEditApproval({
        path: '/workspace/notes.txt',
        originalContent: 'alpha\n',
        proposedContent: 'beta\n',
        sourceTool: 'write_file',
        streamId: 'stream-failed-read',
      });
      await vi.waitFor(() => expect(shown).toHaveLength(1));
      const { requestId } = shown[0];

      controller.handleAction({ requestId, action: 'previewProposed' });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      await rm(opened[0]);

      controller.handleAction({ requestId, action: 'approve' });

      await vi.waitFor(() => expect(shown).toHaveLength(2));
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain('edited document could not be read');
      expect(resolved).toEqual([{ requestId }]);
      expect(shown[1]).toEqual(shown[0]);

      await writeFile(opened[0], 'beta after retry\r\n', 'utf8');
      controller.handleAction({ requestId, action: 'approve' });

      await expect(resultPromise).resolves.toMatchObject({
        action: 'apply',
        appliedContent: 'beta after retry\n',
      });
      expect(resolved).toEqual([{ requestId }, { requestId }]);
    },
  );

  approvalTest(
    'routes LaTeX diff inspection without settling the request',
    async () => {
      const runLatexdiff = vi.fn(async () => {});
      mocks.doMock('@tools/approval/latexPreview', async () => {
        const actual = await vi.importActual<
          typeof import('@tools/approval/latexPreview')
        >('@tools/approval/latexPreview');
        return { ...actual, runLatexdiff };
      });

      const openBuildDisplay = vi.fn(async () => {});
      const { requestToolEditApproval, controller, interactions } =
        await createApprovalFixture({
          ui: createStubDesktopAgentExecutionHost({ openBuildDisplay }),
        });
      const { shownToolEditPermissions: shown } = interactions;

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
      await expect(resultPromise).resolves.toMatchObject({ action: 'reject' });
    },
  );

  approvalTest(
    'uses the injected desktop build display callback for LaTeX preview',
    async () => {
      const workspaceRoot = await createTempRoot('texra-workspace-');
      const displayed: Array<{
        absolutePath: string;
        options?: { preserveFocus?: boolean };
      }> = [];
      const messages: string[] = [];
      const { requestToolEditApproval, controller, interactions } =
        await createApprovalFixture({
          workspacePath: workspaceRoot,
          ui: createStubDesktopAgentExecutionHost({
            openBuildDisplay: async (location, options) => {
              displayed.push({ absolutePath: location.absolutePath, options });
            },
            showErrorMessage: (message) => {
              messages.push(message);
            },
          }),
        });
      const { shownToolEditPermissions: shown } = interactions;

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
      await expect(resultPromise).resolves.toMatchObject({ action: 'reject' });
      await vi.waitFor(async () => {
        await expect(pathExists(displayed[0].absolutePath)).resolves.toBe(
          false,
        );
      });
    },
  );

  approvalTest(
    'does not present a stream approval cancelled during initialization',
    async () => {
      const { requestToolEditApproval, controller, interactions, tempRoot } =
        await createApprovalFixture();

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
        action: 'reject',
        cause: 'Owning execution ended.',
      });
      expect(interactions.shownToolEditPermissions).toEqual([]);
      expect(interactions.resolvedToolEditPermissions).toEqual([]);
      await waitForEmptyDir(tempRoot);
    },
  );

  approvalTest(
    'does not present an approval when disposed during initialization',
    async () => {
      const { requestToolEditApproval, controller, interactions, tempRoot } =
        await createApprovalFixture();

      const resultPromise = requestToolEditApproval({
        path: '/workspace/dispose-during-init.tex',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'write_file',
        streamId: 'stream-dispose-during-init',
      });
      controller.dispose();

      await expect(resultPromise).resolves.toMatchObject({
        action: 'reject',
        cause: SESSION_DISPOSED_CAUSE,
      });
      expect(interactions.shownToolEditPermissions).toEqual([]);
      expect(interactions.resolvedToolEditPermissions).toEqual([]);
      await waitForEmptyDir(tempRoot);
    },
  );

  approvalTest(
    'cancels only tool-edit approvals selected for the owning stream',
    async () => {
      const { requestToolEditApproval, controller, interactions, tempRoot } =
        await createApprovalFixture();
      const {
        shownToolEditPermissions: shown,
        resolvedToolEditPermissions: resolved,
      } = interactions;

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
        action: 'reject',
        cause: 'Owning execution ended.',
      });
      expect(resolved).toEqual([{ requestId: cancelledRequest.requestId }]);

      controller.handleAction({
        requestId: retainedRequest.requestId,
        action: 'reject',
        feedback: 'Retained request resolved normally.',
      });
      await expect(retainedPromise).resolves.toMatchObject({
        action: 'reject',
        feedback: 'Retained request resolved normally.',
      });
      await waitForEmptyDir(tempRoot);
    },
  );

  approvalTest(
    'cleans pending entries and temp files when stream cleanup rejects a request',
    async () => {
      const {
        cleanupApprovalsForStream,
        controller,
        interactions,
        session,
        tempRoot,
      } = await createApprovalFixture();
      session.useHostInteractions({
        requestToolEditApproval: (request) =>
          controller.requestApproval(request),
        cancel: (selector) => controller.cancel(selector),
      });
      const {
        shownToolEditPermissions: shown,
        resolvedToolEditPermissions: resolved,
      } = interactions;

      const resultPromise = session.interactions.requestToolEditApproval({
        path: '/workspace/cleanup.tex',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'write_file',
        streamId: 'stream-cleanup',
      });
      await vi.waitFor(() => expect(shown).toHaveLength(1));

      // Pending interactions are session-owned: sweep the owning session.
      cleanupApprovalsForStream('stream-cleanup', session);

      await expect(resultPromise).resolves.toMatchObject({
        action: 'reject',
        cause: 'Stream resources released.',
      });
      expect(resolved).toEqual([{ requestId: shown[0].requestId }]);
      await waitForEmptyDir(tempRoot);
      expect(await readdir(tempRoot)).toEqual([]);
    },
  );
});
