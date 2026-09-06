import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Effect, Fiber, Stream } from 'effect';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import type { DesktopAgentExecutionHost } from '@desktop/main/desktopAgentExecutionHost';
import type { DiffSource } from '@hosts/uiHosts';

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
import { toolEditApprovalRequest } from '../agent/progressTestUtils';

const approvalTest = (name: string, fn: () => Promise<void>): void => {
  it(name, fn, 30_000);
};

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

async function createTempRoot(prefix = 'texra-approval-'): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
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
    const approvals = createSessionApprovals({ setApprovalBypassState() {} });
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

  const [{ installPlatform }, { nodeFilesystem }] = await Promise.all([
    import('@test/support/setupPlatform'),
    import('@platform/defaults/nodeFilesystem'),
  ]);
  await installPlatform({ workspacePath }, { fs: nodeFilesystem });
  await import('@test/support/sessionGraphTestSetup');

  const [
    { requestToolEditApproval },
    { releaseStreamResources },
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
    releaseStreamResources,
    controllerModule,
    desktopModule,
  };
}

/** A controller with real staged previews and an isolated session. */
async function createApprovalFixture(
  options: {
    ui?: DesktopAgentExecutionHost;
    workspacePath?: string;
  } = {},
) {
  const tempRoot = await createTempRoot();
  const modules = await loadApprovalModules(options.workspacePath);
  const session = disposeAfterTest(createTestSession());
  const host = new modules.desktopModule.DesktopToolEditApprovalHost({
    ui: options.ui ?? createStubDesktopAgentExecutionHost(),
    tempRoot,
  });
  const stagePreview = vi.spyOn(host, 'stagePreview');
  const controller = disposeAfterTest(
    new modules.controllerModule.ToolEditApprovalController({ host }),
  );
  const sessionEvents = Effect.runFork(
    Stream.runForEach(session.events.all(session.now()), (event) =>
      Effect.sync(() => controller.handleSessionEvent(event)),
    ),
  );
  onTestFinished(() => Effect.runPromise(Fiber.interrupt(sessionEvents)));
  modules.activeApproval.requestApproval = (request) =>
    controller.requestApproval(request);
  return {
    ...modules,
    controller,
    session,
    tempRoot,
    async waitForPreviews(count = 1) {
      await vi.waitFor(() => expect(stagePreview).toHaveBeenCalledTimes(count));
      await Promise.all(stagePreview.mock.results.map(({ value }) => value));
      return stagePreview.mock.calls.map(([request]) => request.permission);
    },
  };
}

describe('desktop tool edit approval', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  approvalTest(
    'approves pending edits only in the selected stream',
    async () => {
      const { controller, waitForPreviews } = await createApprovalFixture();

      const target = controller.requestApproval(
        toolEditApprovalRequest({
          path: '/workspace/target.txt',
          originalContent: 'old target\n',
          proposedContent: 'new target\n',
          sourceTool: 'write_file',
          streamId: 'stream-target',
        }),
      );
      const other = controller.requestApproval(
        toolEditApprovalRequest({
          path: '/workspace/other.txt',
          originalContent: 'old other\n',
          proposedContent: 'new other\n',
          sourceTool: 'write_file',
          streamId: 'stream-other',
        }),
      );
      const requests = await waitForPreviews(2);

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

      const otherRequest = requests.find(
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
    'routes proposed-file previews through desktop temp files before rejection',
    async () => {
      const opened: string[] = [];
      const { requestToolEditApproval, controller, waitForPreviews } =
        await createApprovalFixture({
          ui: createStubDesktopAgentExecutionHost({
            openPath: async (filePath) => {
              opened.push(filePath);
            },
          }),
        });

      const resultPromise = requestToolEditApproval({
        path: '/workspace/notes.txt',
        originalContent: 'alpha\n',
        proposedContent: 'beta\n',
        sourceTool: 'write_file',
        streamId: 'stream-2',
      });
      const [request] = await waitForPreviews();

      controller.handleAction({
        requestId: request.requestId,
        action: 'previewProposed',
      });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      expect(path.basename(opened[0])).toContain('proposed');
      await expect(pathExists(opened[0])).resolves.toBe(true);

      controller.handleAction({
        requestId: request.requestId,
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
          _original: DiffSource,
          _proposed: DiffSource,
          _title: string,
        ): Promise<void> => undefined,
      );
      const { requestToolEditApproval, controller, waitForPreviews } =
        await createApprovalFixture({
          ui: createStubDesktopAgentExecutionHost({ openPath, openDiff }),
        });

      const resultPromise = requestToolEditApproval({
        path: '/workspace/main.tex',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'write_file',
      });
      const [request] = await waitForPreviews();
      await vi.waitFor(() => expect(openDiff).toHaveBeenCalledOnce());

      controller.handleAction({
        requestId: request.requestId,
        action: 'openDiff',
      });

      await vi.waitFor(() => expect(openDiff).toHaveBeenCalledTimes(2));
      expect(openPath).not.toHaveBeenCalled();
      const [original, proposed, title] = openDiff.mock.calls[0];
      expect(title).toBe('Tool edit: main.tex');
      await expect(pathExists(original.filePath)).resolves.toBe(true);
      await expect(pathExists(proposed.filePath)).resolves.toBe(true);

      controller.handleAction({
        requestId: request.requestId,
        action: 'reject',
      });
      await expect(resultPromise).resolves.toMatchObject({ action: 'reject' });
    },
  );

  approvalTest(
    'applies user edits made in the proposed preview file',
    async () => {
      const opened: string[] = [];
      const { requestToolEditApproval, controller, waitForPreviews } =
        await createApprovalFixture({
          ui: createStubDesktopAgentExecutionHost({
            openPath: async (filePath) => {
              opened.push(filePath);
            },
          }),
        });

      const resultPromise = requestToolEditApproval({
        path: '/workspace/notes.txt',
        originalContent: 'alpha\n',
        proposedContent: 'beta\n',
        sourceTool: 'write_file',
        streamId: 'stream-edited-preview',
      });
      const [request] = await waitForPreviews();

      controller.handleAction({
        requestId: request.requestId,
        action: 'previewProposed',
      });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      await writeFile(opened[0], 'beta\nwith user edits\nand more\n', 'utf8');

      controller.handleAction({
        requestId: request.requestId,
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
    'reports a failed preview read and accepts a later approval',
    async () => {
      const opened: string[] = [];
      const messages: string[] = [];
      const { requestToolEditApproval, controller, waitForPreviews } =
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

      const resultPromise = requestToolEditApproval({
        path: '/workspace/notes.txt',
        originalContent: 'alpha\n',
        proposedContent: 'beta\n',
        sourceTool: 'write_file',
        streamId: 'stream-failed-read',
      });
      const [request] = await waitForPreviews();
      const { requestId } = request;

      controller.handleAction({ requestId, action: 'previewProposed' });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      await rm(opened[0]);

      controller.handleAction({ requestId, action: 'approve' });

      await vi.waitFor(() => expect(messages).toHaveLength(1));
      expect(messages[0]).toContain('edited document could not be read');

      await writeFile(opened[0], 'beta after retry\r\n', 'utf8');
      controller.handleAction({ requestId, action: 'approve' });

      await expect(resultPromise).resolves.toMatchObject({
        action: 'apply',
        appliedContent: 'beta after retry\n',
      });
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
      const { requestToolEditApproval, controller, waitForPreviews } =
        await createApprovalFixture({
          ui: createStubDesktopAgentExecutionHost({ openBuildDisplay }),
        });

      const resultPromise = requestToolEditApproval({
        path: '/workspace/main.tex',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'write_file',
      });
      const [request] = await waitForPreviews();
      let settled = false;
      void resultPromise.then(() => {
        settled = true;
      });

      controller.handleAction({
        requestId: request.requestId,
        action: 'showLatexdiff',
      });

      await vi.waitFor(() => expect(runLatexdiff).toHaveBeenCalledOnce());
      expect(runLatexdiff).toHaveBeenCalledWith(
        expect.objectContaining({ requestId: request.requestId }),
        {
          subtype: 'ONLYCHANGEDPAGE',
          openBuildDisplay,
        },
      );
      expect(settled).toBe(false);

      controller.handleAction({
        requestId: request.requestId,
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
      const { requestToolEditApproval, controller, waitForPreviews } =
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

      const resultPromise = requestToolEditApproval({
        path: path.join(workspaceRoot, 'main.tex'),
        originalContent:
          '\\documentclass{article}\\begin{document}old\\end{document}\n',
        proposedContent:
          '\\documentclass{article}\\begin{document}new\\end{document}\n',
        sourceTool: 'write_file',
      });
      const [request] = await waitForPreviews();

      controller.handleAction({
        requestId: request.requestId,
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
    'cleans up a stream approval cancelled during initialization',
    async () => {
      const { requestToolEditApproval, controller, tempRoot } =
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
      await waitForEmptyDir(tempRoot);
    },
  );

  approvalTest(
    'cleans up an approval when disposed during initialization',
    async () => {
      const { requestToolEditApproval, controller, tempRoot } =
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
      await waitForEmptyDir(tempRoot);
    },
  );

  approvalTest(
    'cancels only tool-edit approvals selected for the owning stream',
    async () => {
      const { requestToolEditApproval, controller, waitForPreviews, tempRoot } =
        await createApprovalFixture();

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
      const requests = await waitForPreviews(2);
      const cancelledRequest = requests.find(
        (request) => request.streamId === 'stream-cancelled',
      );
      const retainedRequest = requests.find(
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
        releaseStreamResources,
        controller,
        waitForPreviews,
        session,
        tempRoot,
      } = await createApprovalFixture();
      session.interactions.use({
        requestToolEditApproval: (request) =>
          controller.requestApproval(request),
        cancel: (selector) => controller.cancel(selector),
      });

      const resultPromise = session.interactions.requestToolEditApproval(
        toolEditApprovalRequest({
          path: '/workspace/cleanup.tex',
          originalContent: 'old\n',
          proposedContent: 'new\n',
          sourceTool: 'write_file',
          streamId: 'stream-cleanup',
        }),
      );
      await waitForPreviews();

      // Pending interactions are session-owned: sweep the owning session.
      releaseStreamResources('stream-cleanup', session);

      await expect(resultPromise).resolves.toMatchObject({
        action: 'reject',
        cause: 'Stream resources released.',
      });
      await waitForEmptyDir(tempRoot);
      expect(await readdir(tempRoot)).toEqual([]);
    },
  );
});
