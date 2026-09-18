import '@test/support/sessionGraphTestSetup';

import * as path from 'node:path';
import { Effect, FileSystem } from 'effect';
import { it } from '@effect/vitest';
// Test composition imports

// Local imports

// Node imports

// Third-party imports
import { afterEach, beforeEach, describe, expect, vi } from 'vitest';

// Local imports
import { FileInteractionState } from '@agent/core/state/AgentWorkspaceState';
import {
  initializeDefaultSession,
  type SessionHandle,
} from '@agent/runtime/SessionHandle';
import { closeSession } from '@agent/runtime/sessionGraph';
import { appSignals } from '@eventBus/AppSignals';
import { WorkspaceFs } from '@platform/rootedFs';
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

// Local file imports
import { autoDecideRequests, createRecordingHost } from '../progressTestUtils';

/**
 * The previews the host was handed, by request id: the durable request payload
 * carries the edit's coordinates, and the content a decision is taken on
 * reaches the host through `presentToolEdit`.
 */
const stagedToolEdits = new Map<string, ToolEditApprovalRequest>();
let session: SessionHandle;
let detachHostInteractions = (): void => {};
let detachDecider = (): void => {};

/**
 * Answer every tool-edit request this run opens from the staged preview, the
 * way a surface's `request.decide` does.
 */
function decideToolEdits(
  decide: (request: ToolEditApprovalRequest) => RequestDecision,
): void {
  detachDecider = autoDecideRequests(session, (opened) => {
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
  }).then(async () => {
    session = await Effect.runPromise(
      initializeDefaultSession({
        transcriptMode: {
          kind: 'ephemeral',
          reason: 'accept files test session',
        },
      }),
    );
    detachHostInteractions();
    detachHostInteractions = Effect.runSync(
      session.interactions.use({
        presentToolEdit: (request) => {
          stagedToolEdits.set(request.permission.requestId, request);
        },
      }),
    );
    publishTestRunStart(session, runId);
  });
}

/**
 * The write side of the workspace: `accept_run_files` writes through the
 * session's rooted workspace view now that the `WorkspaceFS` facade is gone,
 * so a case stubs that one method of the real service rather than the deleted
 * static.
 */
const workspaceWrites = vi.fn<(target: string, content: string) => void>();
const workspaceReads = new Map<string, { exists: boolean; content: string }>();

/**
 * The absolute-path half: the process filesystem is what the deleted
 * `AbsoluteFS` reached. A path in `absoluteFilePaths` answers as a file, and
 * `absoluteContents` (falling back to `absoluteContentFallback`) is what a
 * read of it returns.
 */
const absoluteFilePaths = new Set<string>();
const absoluteContents = new Map<string, string>();
let absoluteContentFallback = '';

/** Install both stubbed halves over the real services for one tool call. */
function withStubbedFiles<A, E, R>(program: Effect.Effect<A, E, R>) {
  return Effect.gen(function* () {
    const workspaceFs = yield* WorkspaceFs;
    const processFs = yield* FileSystem.FileSystem;
    // One real `Info` to type a declared file with: a stat of a directory
    // that always exists, with only its type asserted.
    const fileInfo = { ...(yield* processFs.stat('/')), type: 'File' as const };
    const infoOf = (type: FileSystem.File.Type) => ({ ...fileInfo, type });
    return yield* program.pipe(
      Effect.provideService(WorkspaceFs, {
        ...workspaceFs,
        exists: (target: string) =>
          Effect.succeed(workspaceReads.get(target)?.exists ?? false),
        readFile: (target: string) =>
          Effect.succeed(
            Buffer.from(workspaceReads.get(target)?.content ?? '', 'utf-8'),
          ),
        writeFile: (target: string, content: Uint8Array) => {
          workspaceWrites(target, Buffer.from(content).toString('utf-8'));
          return Effect.void;
        },
        remove: () => Effect.void,
      }),
      Effect.provideService(FileSystem.FileSystem, {
        ...processFs,
        exists: (target: string) =>
          runStorageEntries.has(target)
            ? Effect.succeed(true)
            : processFs.exists(target),
        // The entry probe reads a link through `readLink`, so a seeded
        // symlink answers here and everything else falls through.
        readLink: (target: string) =>
          runStorageEntries.get(target) === 'SymbolicLink'
            ? Effect.succeed(target)
            : processFs.readLink(target),
        stat: (target: string) => {
          if (absoluteFilePaths.has(target)) return Effect.succeed(fileInfo);
          const seeded = runStorageEntries.get(target);
          if (seeded !== undefined) return Effect.succeed(infoOf(seeded));
          // A path no case named: the real filesystem's own failure, so the
          // probe's `NotFound` reading sees the `PlatformError` it handles.
          return processFs.stat(target);
        },
        readFile: (target: string) =>
          Effect.succeed(
            Buffer.from(
              absoluteContents.get(target) ?? absoluteContentFallback,
              'utf-8',
            ),
          ),
      }),
    );
  });
}

/**
 * The run-storage half: each entry the walk probes, by absolute path, with the
 * type `lstat` reports for it. Run storage is read through the process
 * filesystem now, so these are seeded in the same stub the absolute reads are.
 */
const runStorageEntries = new Map<string, FileSystem.File.Type>();

/** `root` is the storage root the call under test carries as data. */
function setRunStorageEntries(
  entries: Readonly<Record<string, FileSystem.File.Type>> = {},
  root: string = storagePath,
): void {
  const types = new Map<string, FileSystem.File.Type>([
    [`executions/${runId}`, 'Directory'],
    ...Object.entries(entries),
  ]);
  for (const entry of Object.keys(entries)) {
    let parent = path.posix.dirname(entry);
    while (parent !== '.' && parent !== `executions/${runId}`) {
      types.set(parent, 'Directory');
      parent = path.posix.dirname(parent);
    }
  }
  runStorageEntries.clear();
  for (const [target, type] of types) {
    runStorageEntries.set(path.join(root, target), type);
  }
}

/** Stubs the workspace side of an accept and returns the write spy. */
function stubWorkspaceFiles(exists: boolean, content: string) {
  workspaceReads.set('draft.tex', { exists, content });
  workspaceReads.set('paper.tex', { exists, content });
  return workspaceWrites;
}

function runAccept(
  tool: AcceptRunFilesTool,
  files: { path: string; original: string }[],
  tracker = new FileInteractionState(),
) {
  return withStubbedFiles(tool.call({ execution_id: runId, files })).pipe(
    Effect.provide(
      nativeToolTestLayer({
        tracker,
        run: { runId, session: session, toolPolicy: {} },
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
    workspaceWrites.mockReset();
    workspaceReads.clear();
    absoluteFilePaths.clear();
    absoluteContents.clear();
    absoluteContentFallback = '';
    await installTestPlatform();
    session.approvals.clearAll();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    detachDecider();
    detachDecider = () => {};
    detachHostInteractions();
    detachHostInteractions = () => {};
    stagedToolEdits.clear();
    session.approvals.clearAll();
    await Effect.runPromise(closeSession(session.roots.storage));
  });

  it.live('publishes accepted workspace files through app signals', () =>
    Effect.gen(function* () {
      const explicit = createRecordingHost();
      const tool = new AcceptRunFilesTool();
      const tracker = new FileInteractionState();
      const { written, dispose } = recordWrittenFiles();

      setRunStorageEntries({
        [`executions/${runId}/output.tex`]: 'File',
      });
      stubWorkspaceFiles(false, '');
      absoluteContentFallback = 'accepted content';
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
          [`executions/${runId}/output.tex`]: 'File',
        });
        stubWorkspaceFiles(false, '');
        absoluteContentFallback = 'proposed content';
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
          [`executions/${runId}/output.tex`]: 'File',
        });
        stubWorkspaceFiles(false, '');
        absoluteContentFallback = 'proposed content';
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
        [`executions/${runId}/first.tex`]: 'File',
        [`executions/${runId}/second.tex`]: 'File',
      });
      stubWorkspaceFiles(false, '');
      absoluteContentFallback = 'proposed content';
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
      absoluteFilePaths.add(snapshotPath);
      absoluteContents.set(snapshotPath, 'old content');
      absoluteContentFallback = 'new content';
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

        setRunStorageEntries({}, projectRoots.storage);
        workspaceReads.set('draft.tex', {
          exists: true,
          content: 'current project',
        });
        workspaceReads.set('paper.tex', {
          exists: true,
          content: 'current project',
        });
        absoluteFilePaths.add(snapshotPath);
        absoluteContents.set(snapshotPath, 'original project');
        absoluteContents.set('/project/draft.tex', 'proposed project');
        absoluteContentFallback = 'wrong project';
        decideToolEdits((request) => {
          approvalOriginal = request.originalContent;
          approvalProposed = request.proposedContent;
          return { action: 'approve' };
        });

        const result = yield* withStubbedFiles(
          tool.call({
            execution_id: runId,
            files: [{ path: 'draft.tex', original: 'paper.tex' }],
          }),
        ).pipe(
          Effect.provide(
            nativeToolTestLayer({
              tracker,
              run: { runId, session: session, toolPolicy: {} },
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
      absoluteContentFallback = 'same content';
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
          [`executions/${runId}/r1/Draft/appendices.tex`]: 'SymbolicLink',
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
