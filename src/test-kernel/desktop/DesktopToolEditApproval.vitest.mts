import { access, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ProgressEventPayloads } from '@eventBus/ProgressEventBus';

import { desktopSourcePath, moduleFileUrl } from './desktopTestPaths.mjs';

interface DesktopToolEditApprovalModule {
  createDesktopToolEditApprovalController(options: {
    openPath?: (filePath: string) => Promise<void>;
    showMessage?: (message: string) => Promise<void> | void;
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

async function loadApprovalModules() {
  vi.resetModules();
  vi.doMock('@agent/core/config', () => ({
    getConfig: vi.fn(() => true),
  }));
  vi.doMock('@agent/toolUse/ToolFileInteractionContext', () => ({
    getCurrentToolFileInteractionContext: vi.fn(() => undefined),
  }));
  vi.doMock('@utils/files', async () => {
    const actual =
      await vi.importActual<typeof import('@utils/files')>('@utils/files');
    return {
      ...actual,
      WorkspaceFS: {
        relativePath(filePath: string): string {
          return filePath.startsWith('/workspace/')
            ? filePath.slice('/workspace/'.length)
            : filePath;
        },
      },
    };
  });

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
