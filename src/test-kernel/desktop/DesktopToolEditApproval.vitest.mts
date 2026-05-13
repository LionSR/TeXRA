import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';
import type {
  DiffOptions,
  DiffSession,
  DiffSource,
  DiffViewHost,
} from '@hosts/diffViewHost';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopToolEditApprovalModule {
  createDesktopToolEditApprovalController(options: {
    openPath?: (filePath: string) => Promise<void>;
    openBuildDisplay?: (
      location: { absolutePath: string },
      options?: { preserveFocus?: boolean },
    ) => Promise<void>;
    openDiff?: DiffViewHost['openDiff'];
    showErrorMessage?: (message: string) => Promise<void> | void;
    tempRoot?: string;
  }): {
    handleAction(payload: {
      requestId: string;
      action: string;
      feedback?: string;
    }): boolean;
    dispose(): void;
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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
  vi.doMock('@agent/core/config', () => ({
    getConfig: vi.fn(() => 'sameDirectory'),
  }));
  vi.doMock('@agent/toolUse/ToolFileInteractionContext', () => ({
    getCurrentToolFileInteractionContext: vi.fn(() => undefined),
    getCurrentToolRunContext: vi.fn(() => undefined),
  }));
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

  const [{ initPlatform }, { createFakePlatform }] = await Promise.all([
    import('@platform/platform'),
    import('@test/support/FakePlatform'),
  ]);
  initPlatform(createFakePlatform({ workspacePath }));

  const [
    { bus },
    { requestToolEditApproval },
    { cleanupApprovalsForStream },
    desktopModule,
  ] = await Promise.all([
    import('@eventBus/ProgressEventBus'),
    import('@tools/approval/toolEditApproval'),
    import('@tools/approval'),
    import(
      moduleFileUrl(desktopSourcePath('main', 'desktopToolEditApproval.ts'))
    ) as Promise<DesktopToolEditApprovalModule>,
  ]);
  return {
    bus,
    requestToolEditApproval,
    cleanupApprovalsForStream,
    desktopModule,
  };
}

describe('desktop tool edit approval', () => {
  afterEach(() => {
    vi.doUnmock('@agent/core/config');
    vi.doUnmock('@agent/toolUse/ToolFileInteractionContext');
    vi.doUnmock('@utils/files');
    vi.restoreAllMocks();
  });

  it('registers the desktop approval handler and resolves approved edits', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
    const { bus, requestToolEditApproval, desktopModule } =
      await loadApprovalModules();
    const controller = desktopModule.createDesktopToolEditApprovalController({
      tempRoot,
    });
    const shown: ProgressEventPayloads['showToolEditPermission'][] = [];
    const resolved: ProgressEventPayloads['resolveToolEditPermission'][] = [];
    const offShow = bus.on('showToolEditPermission', (payload) =>
      shown.push(payload),
    );
    const offResolve = bus.on('resolveToolEditPermission', (payload) =>
      resolved.push(payload),
    );

    try {
      const resultPromise = requestToolEditApproval({
        path: '/workspace/main.tex',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'replace_file',
        streamId: 'stream-1',
      });

      await vi.waitFor(() => expect(shown).toHaveLength(1));
      expect(shown[0]).toMatchObject({
        path: '/workspace/main.tex',
        relativePath: 'main.tex',
        sourceTool: 'replace_file',
        streamId: 'stream-1',
        isLatex: true,
      });

      expect(
        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'approve',
        }),
      ).toBe(true);

      await expect(resultPromise).resolves.toMatchObject({
        accepted: true,
        appliedContent: 'new\n',
        lineChanges: { added: 1, removed: 1 },
      });
      expect(resolved).toEqual([{ requestId: shown[0].requestId }]);
    } finally {
      offShow();
      offResolve();
      controller.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('routes preview and diff actions through desktop temp files before rejection', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
    const { bus, requestToolEditApproval, desktopModule } =
      await loadApprovalModules();
    const opened: string[] = [];
    const controller = desktopModule.createDesktopToolEditApprovalController({
      tempRoot,
      openPath: async (filePath) => {
        opened.push(filePath);
      },
    });
    const shown: ProgressEventPayloads['showToolEditPermission'][] = [];
    const offShow = bus.on('showToolEditPermission', (payload) =>
      shown.push(payload),
    );

    try {
      const resultPromise = requestToolEditApproval({
        path: '/workspace/notes.txt',
        originalContent: 'alpha\n',
        proposedContent: 'beta\n',
        sourceTool: 'write_file',
        streamId: 'stream-2',
      });
      await vi.waitFor(() => expect(shown).toHaveLength(1));

      controller.handleAction({
        requestId: shown[0].requestId,
        action: 'previewProposed',
      });
      await vi.waitFor(() => expect(opened).toHaveLength(1));
      expect(path.basename(opened[0])).toContain('proposed');
      await expect(pathExists(opened[0])).resolves.toBe(true);

      controller.handleAction({
        requestId: shown[0].requestId,
        action: 'openDiff',
      });
      await vi.waitFor(() => expect(opened).toHaveLength(2));
      expect(opened[1].endsWith('.diff')).toBe(true);
      await expect(pathExists(opened[1])).resolves.toBe(true);

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
        await expect(pathExists(opened[1])).resolves.toBe(false);
      });
    } finally {
      offShow();
      controller.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('routes diff actions through the injected desktop diff host when available', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
    const { bus, requestToolEditApproval, desktopModule } =
      await loadApprovalModules();
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
      tempRoot,
      openPath,
      openDiff,
    });
    const shown: ProgressEventPayloads['showToolEditPermission'][] = [];
    const offShow = bus.on('showToolEditPermission', (payload) =>
      shown.push(payload),
    );

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
      offShow();
      controller.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('applies user edits made in the proposed preview file', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
    const { bus, requestToolEditApproval, desktopModule } =
      await loadApprovalModules();
    const opened: string[] = [];
    const controller = desktopModule.createDesktopToolEditApprovalController({
      tempRoot,
      openPath: async (filePath) => {
        opened.push(filePath);
      },
    });
    const shown: ProgressEventPayloads['showToolEditPermission'][] = [];
    const offShow = bus.on('showToolEditPermission', (payload) =>
      shown.push(payload),
    );

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

      expect(
        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'approve',
        }),
      ).toBe(true);

      await expect(resultPromise).resolves.toMatchObject({
        accepted: true,
        appliedContent: 'beta\nwith user edits\nand more\n',
        lineChanges: { added: 3, removed: 1 },
      });
      await vi.waitFor(async () => {
        await expect(pathExists(opened[0])).resolves.toBe(false);
      });
    } finally {
      offShow();
      controller.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('uses the injected desktop build display callback for LaTeX preview', async () => {
    const workspaceRoot = await mkdtemp(
      path.join(tmpdir(), 'texra-workspace-'),
    );
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
    const { bus, requestToolEditApproval, desktopModule } =
      await loadApprovalModules(workspaceRoot);
    const displayed: Array<{
      absolutePath: string;
      options?: { preserveFocus?: boolean };
    }> = [];
    const messages: string[] = [];
    const controller = desktopModule.createDesktopToolEditApprovalController({
      tempRoot,
      openBuildDisplay: async (location, options) => {
        displayed.push({ absolutePath: location.absolutePath, options });
      },
      showErrorMessage: (message) => {
        messages.push(message);
      },
    });
    const shown: ProgressEventPayloads['showToolEditPermission'][] = [];
    const offShow = bus.on('showToolEditPermission', (payload) =>
      shown.push(payload),
    );

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
        /^main_preview-[a-f0-9]{8}\.tex$/,
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
      offShow();
      controller.dispose();
      await rm(tempRoot, { recursive: true, force: true });
      await rm(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('cleans pending entries and temp files when stream cleanup rejects a request', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
    const {
      bus,
      requestToolEditApproval,
      cleanupApprovalsForStream,
      desktopModule,
    } = await loadApprovalModules();
    const controller = desktopModule.createDesktopToolEditApprovalController({
      tempRoot,
    });
    const shown: ProgressEventPayloads['showToolEditPermission'][] = [];
    const resolved: ProgressEventPayloads['resolveToolEditPermission'][] = [];
    const offShow = bus.on('showToolEditPermission', (payload) =>
      shown.push(payload),
    );
    const offResolve = bus.on('resolveToolEditPermission', (payload) =>
      resolved.push(payload),
    );

    try {
      const resultPromise = requestToolEditApproval({
        path: '/workspace/cleanup.tex',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'write_file',
        streamId: 'stream-cleanup',
      });
      await vi.waitFor(() => expect(shown).toHaveLength(1));

      cleanupApprovalsForStream('stream-cleanup');

      await expect(resultPromise).resolves.toMatchObject({ accepted: false });
      expect(resolved).toEqual([{ requestId: shown[0].requestId }]);
      await waitForEmptyDir(tempRoot);
      expect(await readdir(tempRoot)).toEqual([]);
    } finally {
      offShow();
      offResolve();
      controller.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it('returns false for unknown approval actions', async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), 'texra-approval-'));
    const { bus, requestToolEditApproval, desktopModule } =
      await loadApprovalModules();
    const controller = desktopModule.createDesktopToolEditApprovalController({
      tempRoot,
    });
    const shown: ProgressEventPayloads['showToolEditPermission'][] = [];
    const offShow = bus.on('showToolEditPermission', (payload) =>
      shown.push(payload),
    );

    try {
      const resultPromise = requestToolEditApproval({
        path: '/workspace/unknown-action.tex',
        originalContent: 'old\n',
        proposedContent: 'new\n',
        sourceTool: 'write_file',
      });
      await vi.waitFor(() => expect(shown).toHaveLength(1));

      expect(
        controller.handleAction({
          requestId: shown[0].requestId,
          action: 'unexpected',
        }),
      ).toBe(false);

      controller.dispose();
      await expect(resultPromise).resolves.toMatchObject({ accepted: false });
    } finally {
      offShow();
      controller.dispose();
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});
