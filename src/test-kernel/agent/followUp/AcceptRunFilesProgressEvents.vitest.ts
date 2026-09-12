import '@test/support/defaultSessionTestSetup';

import * as path from 'node:path';
import { Effect } from 'effect';
import { it } from '@effect/vitest';
// Test composition imports

// Local imports

// Node imports

// Third-party imports
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import { defaultSession } from '@agent/runtime/SessionHandle';
import { appSignals } from '@eventBus/AppSignals';
import { FileType, type FileStat } from '@platform/interfaces';
import {
  runWithWorkspaceRoots,
  workspaceRoots,
} from '@platform/workspaceRoots';
import type { RequestDecision, RunId } from '@shared/schemas';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import { AcceptRunFilesTool } from '@tools/AcceptRunFilesTool';
import { type ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { AbsoluteFS } from '@utils/files/absoluteFS';
import { StorageFS } from '@utils/files/storageFS';
import { WorkspaceFS } from '@utils/files/workspaceFS';

// Local file imports
import { autoDecideRequests, createRecordingHost } from '../progressTestUtils';

/**
 * The previews the host was handed, by request id: the durable request payload
 * carries the edit's coordinates, and the content a decision is taken on
 * reaches the host through `presentToolEdit`.
 */
const stagedToolEdits = new Map<string, ToolEditApprovalRequest>();
let detachHostInteractions = (): void => {};
let detachDecider = (): void => {};

/**
 * Answer every tool-edit request this run opens from the staged preview, the
 * way a surface's `request.decide` does.
 */
function decideToolEdits(
  decide: (request: ToolEditApprovalRequest) => RequestDecision,
): void {
  detachDecider = autoDecideRequests(defaultSession(), (opened) => {
    if (opened.payload.kind !== 'toolEdit') return null;
    const preview = stagedToolEdits.get(opened.payload.data.requestId);
    if (!preview) {
      throw new Error('The tool-edit request staged no preview.');
    }
    return decide(preview);
  }).detach;
}

const runId = 'abcdef' as RunId;
const workspacePath = '/workspace';
const storagePath = '/storage';

function installTestPlatform(): Promise<void> {
  return installPlatform({
    workspacePath,
    storagePath,
    globalStoragePath: '/global/.texra/storage',
  }).then(() => {
    detachHostInteractions();
    detachHostInteractions = defaultSession().interactions.use({
      presentToolEdit: (request) => {
        stagedToolEdits.set(request.permission.requestId, request);
      },
    });
    publishTestRunStart(defaultSession(), runId);
  });
}

function runStorageStat(type: number): FileStat {
  return { type, ctime: 0, mtime: 0, size: 1 };
}

function setRunStorageEntries(
  entries: Readonly<Record<string, number>> = {},
): void {
  const types = new Map<string, number>([
    [`executions/${runId}`, FileType.Directory],
    ...Object.entries(entries),
  ]);
  for (const entry of Object.keys(entries)) {
    let parent = path.posix.dirname(entry);
    while (parent !== '.' && parent !== `executions/${runId}`) {
      types.set(parent, FileType.Directory);
      parent = path.posix.dirname(parent);
    }
  }
  vi.spyOn(StorageFS, 'exists').mockImplementation(async (target) =>
    types.has(target),
  );
  vi.spyOn(StorageFS, 'stat').mockImplementation(async (target) => {
    const type = types.get(target);
    if (type !== undefined) return runStorageStat(type);
    throw Object.assign(new Error(`Missing: ${target}`), { code: 'ENOENT' });
  });
}

/** Stubs the workspace side of an accept and returns the write spy. */
function stubWorkspaceFiles(exists: boolean, content: string) {
  vi.spyOn(WorkspaceFS, 'exists').mockResolvedValue(exists);
  vi.spyOn(WorkspaceFS, 'read').mockResolvedValue(content);
  vi.spyOn(WorkspaceFS, 'delete').mockResolvedValue(undefined);
  return vi.spyOn(WorkspaceFS, 'write').mockResolvedValue(undefined);
}

function runAccept(
  tool: AcceptRunFilesTool,
  files: { path: string; original: string }[],
  tracker = new FileInteractionState(),
) {
  return tool.call({ execution_id: runId, files }).pipe(
    Effect.provide(
      nativeToolTestLayer({
        tracker,
        run: { runId, session: defaultSession(), toolPolicy: {} },
      }),
    ),
  );
}

/** Collects workspaceFilesWritten payloads until disposed. */
function recordWrittenFiles(): { written: string[][]; dispose: () => void } {
  const written: string[][] = [];
  const dispose = appSignals.on(
    'workspaceFilesWritten',
    ({ absolutePaths }) => {
      written.push(absolutePaths);
    },
  );
  return { written, dispose };
}

describe('accept_run_files progress events', () => {
  beforeEach(async () => {
    stagedToolEdits.clear();
    await installTestPlatform();
    defaultSession().approvals.clearAll();
    // Shared by every test below that stubs the run/workspace paths;
    // the test that doesn't need it (missing runtime host) fails before
    // reaching either function.
    vi.spyOn(StorageFS, 'fullPath').mockImplementation(
      (target) => `${storagePath}/${target}`,
    );
    vi.spyOn(WorkspaceFS, 'locatePath').mockImplementation((target) => ({
      kind: 'workspace',
      absolutePath: `${workspacePath}/${target}`,
      relativePath: target,
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    detachDecider();
    detachDecider = () => {};
    detachHostInteractions();
    detachHostInteractions = () => {};
    stagedToolEdits.clear();
    defaultSession().approvals.clearAll();
  });

  it.live('publishes accepted workspace files through app signals', () =>
    Effect.gen(function* () {
      const explicit = createRecordingHost();
      const tool = new AcceptRunFilesTool();
      const tracker = new FileInteractionState();
      const { written, dispose } = recordWrittenFiles();

      setRunStorageEntries({
        [`executions/${runId}/output.tex`]: FileType.File,
      });
      stubWorkspaceFiles(false, '');
      vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('accepted content');
      decideToolEdits(() => ({ action: 'approve' }));

      const result = yield* runAccept(
        tool,
        [{ path: 'output.tex', original: 'paper.tex' }],
        tracker,
      );

      expect(result.status).toBe('executed');
      expect(explicit.events).toEqual([]);
      expect(written).toEqual([[`${workspacePath}/paper.tex`]]);
      expect(tracker.hasRead('paper.tex')).toBe(true);
      dispose();
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live(
    'reports an all-file user rejection without calling it a cancellation',
    () =>
      Effect.gen(function* () {
        const tool = new AcceptRunFilesTool();

        setRunStorageEntries({
          [`executions/${runId}/output.tex`]: FileType.File,
        });
        stubWorkspaceFiles(false, '');
        vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('proposed content');
        decideToolEdits(() => ({
          action: 'reject',
          feedback: 'keep the original normalization',
        }));

        const result = yield* runAccept(tool, [
          { path: 'output.tex', original: 'paper.tex' },
        ]);

        expect(result.status).toBe('error');
        expect(result.summary).toBe(
          'User rejected accept_run_files for paper.tex.',
        );
        expect(result.userInstruction).toBe('keep the original normalization');
        expect(result.error).not.toContain('cancelled');
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live(
    'preserves a cause-free cancellation while aggregating rejections',
    () =>
      Effect.gen(function* () {
        const tool = new AcceptRunFilesTool();

        setRunStorageEntries({
          [`executions/${runId}/output.tex`]: FileType.File,
        });
        stubWorkspaceFiles(false, '');
        vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('proposed content');
        decideToolEdits(() => ({ action: 'cancel', cause: null }));

        const result = yield* runAccept(tool, [
          { path: 'output.tex', original: 'paper.tex' },
        ]);

        expect(result.summary).toBe(
          'Tool edit cancelled: accept_run_files for paper.tex.',
        );
        expect(result.userInstruction).toBeUndefined();
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live('preserves mixed policy-denial and cancellation details', () =>
    Effect.gen(function* () {
      const tool = new AcceptRunFilesTool();

      setRunStorageEntries({
        [`executions/${runId}/first.tex`]: FileType.File,
        [`executions/${runId}/second.tex`]: FileType.File,
      });
      stubWorkspaceFiles(false, '');
      vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('proposed content');
      decideToolEdits((request) =>
        request.path === 'first.tex'
          ? { action: 'deny', reason: 'Denied by approval policy.' }
          : { action: 'cancel', cause: 'Session disposed.' },
      );

      const result = yield* runAccept(tool, [
        { path: 'first.tex', original: 'first.tex' },
        { path: 'second.tex', original: 'second.tex' },
      ]);

      expect(result.status).toBe('error');
      // A cancellation outranks a denial: the one refusal reported names the
      // cancelled file and carries its cause.
      expect(result.summary).toBe(
        'Tool edit cancelled: accept_run_files for second.tex.',
      );
      expect(result.error).toContain('Session disposed.');
      expect(result.userInstruction).toBeUndefined();
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live('uses the pre-run snapshot for same-path workspace outputs', () =>
    Effect.gen(function* () {
      const tool = new AcceptRunFilesTool();
      let approvalOriginal = '';
      let approvalProposed = '';
      const snapshotPath = `${storagePath}/executions/${runId}/original/draft.tex`;

      setRunStorageEntries();
      const write = stubWorkspaceFiles(true, 'new content');
      vi.spyOn(AbsoluteFS, 'isFile').mockImplementation(
        async (target) => target === snapshotPath,
      );
      vi.spyOn(AbsoluteFS, 'read').mockImplementation(async (target) =>
        target === snapshotPath ? 'old content' : 'new content',
      );
      decideToolEdits((request) => {
        approvalOriginal = request.originalContent;
        approvalProposed = request.proposedContent;
        return { action: 'approve' };
      });

      const result = yield* runAccept(tool, [
        { path: 'draft.tex', original: 'draft.tex' },
      ]);

      expect(result.status).toBe('executed');
      expect(approvalOriginal).toBe('old content');
      expect(approvalProposed).toBe('new content');
      expect(result.edits?.[0]?.lineChanges).toEqual({
        added: 1,
        removed: 1,
      });
      expect(write).not.toHaveBeenCalled();
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live(
    'uses the invoking project roots for workspace fallbacks and snapshots',
    () =>
      Effect.gen(function* () {
        const projectRoots = {
          ...workspaceRoots(),
          workspace: '/project',
          storage: '/project-storage',
        };
        const tool = new AcceptRunFilesTool();
        const tracker = new FileInteractionState();
        const snapshotPath = `${projectRoots.storage}/executions/${runId}/original/paper.tex`;
        let approvalOriginal = '';
        let approvalProposed = '';
        const { written, dispose } = recordWrittenFiles();

        setRunStorageEntries();
        vi.spyOn(StorageFS, 'fullPath').mockImplementation(
          (target) => `${workspaceRoots().storage}/${target}`,
        );
        vi.spyOn(WorkspaceFS, 'locatePath').mockImplementation((target) => ({
          kind: 'workspace',
          absolutePath: `${workspaceRoots().workspace}/${target}`,
          relativePath: target,
        }));
        vi.spyOn(WorkspaceFS, 'exists').mockResolvedValue(true);
        vi.spyOn(WorkspaceFS, 'read').mockResolvedValue('current project');
        vi.spyOn(WorkspaceFS, 'delete').mockResolvedValue(undefined);
        vi.spyOn(WorkspaceFS, 'write').mockResolvedValue(undefined);
        vi.spyOn(AbsoluteFS, 'isFile').mockImplementation(
          async (target) => target === snapshotPath,
        );
        vi.spyOn(AbsoluteFS, 'read').mockImplementation(async (target) => {
          if (target === snapshotPath) return 'original project';
          if (target === '/project/draft.tex') return 'proposed project';
          return 'wrong project';
        });
        decideToolEdits((request) => {
          approvalOriginal = request.originalContent;
          approvalProposed = request.proposedContent;
          return { action: 'approve' };
        });

        const result = yield* tool
          .call({
            execution_id: runId,
            files: [{ path: 'draft.tex', original: 'paper.tex' }],
          })
          .pipe(
            Effect.provide(
              nativeToolTestLayer({
                tracker,
                run: { runId, session: defaultSession(), toolPolicy: {} },
                inScope: (operation) =>
                  runWithWorkspaceRoots(projectRoots, operation),
              }),
            ),
          );

        expect(result.status).toBe('executed');
        expect({ approvalOriginal, approvalProposed, written }).toEqual({
          approvalOriginal: 'original project',
          approvalProposed: 'proposed project',
          written: [['/project/paper.tex']],
        });
        dispose();
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live('reports unchanged same-path fallbacks without approval', () =>
    Effect.gen(function* () {
      const explicit = createRecordingHost();
      const tool = new AcceptRunFilesTool();
      let approvals = 0;

      setRunStorageEntries();
      const write = stubWorkspaceFiles(true, 'same content');
      vi.spyOn(AbsoluteFS, 'isFile').mockResolvedValue(false);
      vi.spyOn(AbsoluteFS, 'read').mockResolvedValue('same content');
      decideToolEdits(() => {
        approvals++;
        return { action: 'approve' };
      });

      const result = yield* runAccept(tool, [
        { path: 'draft.tex', original: 'draft.tex' },
      ]);

      expect(result.status).toBe('executed');
      expect(result.output).toContain('No changes to accept');
      expect(result.output).toContain('unchanged: draft.tex');
      expect(approvals).toBe(0);
      expect(write).not.toHaveBeenCalled();
      expect(explicit.events).toEqual([]);
    }).pipe(Effect.provide(nativeToolTestLayer())),
  );

  it.live(
    'refuses symlinked run-storage entries so unemitted files cannot be accepted',
    () =>
      Effect.gen(function* () {
        const explicit = createRecordingHost();
        const tool = new AcceptRunFilesTool();
        let approvals = 0;

        setRunStorageEntries({
          [`executions/${runId}/r1/Draft/appendices.tex`]:
            FileType.SymbolicLink | FileType.File,
        });
        const write = stubWorkspaceFiles(true, '');
        decideToolEdits(() => {
          approvals++;
          return { action: 'approve' };
        });

        const result = yield* runAccept(tool, [
          { path: 'r1/Draft/appendices.tex', original: 'Draft/appendices.tex' },
        ]);

        expect(result.status).toBe('error');
        expect(result.error).toContain('symlink');
        expect(result.error).toContain('did not emit');
        expect(approvals).toBe(0);
        expect(write).not.toHaveBeenCalled();
        expect(explicit.events).toEqual([]);
      }).pipe(Effect.provide(nativeToolTestLayer())),
  );
});
