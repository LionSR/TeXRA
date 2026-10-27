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
import { type SessionHandle } from '@agent/runtime/SessionHandle';
import { WorkspaceFs } from '@platform/rootedFs';
import type { RequestDecision, RunId } from '@shared/schemas';
import { testWorkspaceRoots } from '@test/support/testWorkspaceRoots';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import { installPlatform } from '@test/support/setupPlatform';
import { publishTestRunStart } from '@test/support/sessionTestUtils';
import {
  closeTestSession,
  openTestDefaultSession,
} from '@test/support/sessionEnd';
import { AcceptRunFilesTool } from '@texra/tools/AcceptRunFilesTool';
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
// The two roots this suite installs. Every absolute path built from them —
// a stub's key, an expectation — goes through `path.join`, because that is
// what the code under test joins with: an interpolated `/` names a different
// file wherever the separator is not `/`.
const workspacePath = '/workspace';
const storagePath = '/storage';

function installTestPlatform(): Promise<void> {
  return installPlatform({
    workspacePath,
    storagePath,
    globalStoragePath: '/global/.texra/storage',
  }).then(async () => {
    session = await Effect.runPromise(
      openTestDefaultSession({
        roots: testWorkspaceRoots(),
        transcriptMode: { kind: 'ephemeral' },
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
 * session's rooted `WorkspaceFs` view, so a case stubs that one method of the
 * real service.
 */
const workspaceWrites = vi.fn<(target: string, content: string) => void>();
const workspaceReads = new Map<string, { exists: boolean; content: string }>();

/**
 * The absolute-path half, read through the process `FileSystem`. A path in
 * `absoluteFilePaths` answers as a file, and
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
        // A declared file answers as one; anything else is the real
        // view's own `NotFound`.
        stat: (target: string) =>
          workspaceReads.get(target)?.exists
            ? Effect.succeed(fileInfo)
            : workspaceFs.stat(target),
        readFile: (target: string) =>
          Effect.succeed(
            Buffer.from(workspaceReads.get(target)?.content ?? '', 'utf-8'),
          ),
        writeFile: (target: string, content: Uint8Array) => {
          workspaceWrites(target, Buffer.from(content).toString('utf-8'));
          return Effect.void;
        },
        makeDirectory: () => Effect.void,
        remove: () => Effect.void,
      }),
      Effect.provideService(FileSystem.FileSystem, {
        ...processFs,
        // The entry probe is one `lstat`, so a seeded symlink answers as
        // one; a declared file answers through `stat` as well.
        lstat: (target: string) => {
          const seeded = runStorageEntries.get(target);
          if (seeded !== undefined) return Effect.succeed(infoOf(seeded));
          if (absoluteFilePaths.has(target)) return Effect.succeed(fileInfo);
          // A path no case named: the real filesystem's own failure, so the
          // probe's `NotFound` reading sees the `PlatformError` it handles.
          return processFs.lstat(target);
        },
        stat: (target: string) => {
          if (absoluteFilePaths.has(target)) return Effect.succeed(fileInfo);
          const seeded = runStorageEntries.get(target);
          if (seeded !== undefined) return Effect.succeed(infoOf(seeded));
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
  tool: typeof AcceptRunFilesTool,
  files: { path: string; original: string }[],
  readFiles = new Set<string>(),
) {
  return withStubbedFiles(tool.call({ execution_id: runId, files })).pipe(
    Effect.provide(
      nativeToolTestLayer({
        readFiles,
        run: { runId, session: session, toolPolicy: {} },
      }),
    ),
  );
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
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    detachDecider();
    detachDecider = () => {};
    detachHostInteractions();
    detachHostInteractions = () => {};
    stagedToolEdits.clear();
    await Effect.runPromise(closeTestSession(session.roots.storage));
  });

  it.live(
    'refuses symlinked run-storage entries so unemitted files cannot be accepted',
    () =>
      Effect.gen(function* () {
        const explicit = createRecordingHost();
        const tool = AcceptRunFilesTool;
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
