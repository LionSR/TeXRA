// Test composition imports

// Node imports
import * as assert from 'node:assert';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

// Third-party imports
import { layer } from '@effect/vitest';
import { Deferred, Effect, Fiber, FileSystem, Layer, Context } from 'effect';

// Local imports

import { generateRunId, type RequestDecision } from '@texra-ai/harness/schemas';
import {
  requestToolEditApproval,
  type PluginToolServices,
} from '@texra-ai/harness/plugins';
import { WorkspaceFs } from '@texra-ai/harness/host';
import { SessionRequests } from '@agent/runtime/requests';
import { SessionLog } from '@shared/session/runHistory';
import {
  setTestApprovalPolicy,
  publishTestRunStart,
} from '@test/support/sessionTestUtils';
import { nativeToolTestLayer } from '@test/support/nativeToolTestLayer';
import {
  FakeHost,
  SessionGraph,
  sessionHandleOf,
  TestSession,
} from '@test/support/testKernel';
import { EditFileTool } from '@tools/EditTool';
import { writeFileTool } from '@tools/WriteTool';

// Local file imports
import { autoDecideRequests, decideRequest } from '../agent/progressTestUtils';

/**
 * Every case's start, for the test's scope: a host over a real workspace
 * directory (the edit flow reads the current content through the process
 * filesystem, so a file a case stubs has to exist where the workspace says
 * it does), a session of its own over the host's roots with the policy at
 * `ask`, and a freshly started run whose requests a surface answers with
 * `decide`. A case that must leave a request pending returns null and decides
 * it later with `decideRequest`.
 */
const setUp = (
  decide: () => RequestDecision | null = () => ({ action: 'approve' }),
) =>
  Effect.gen(function* () {
    const host = Context.get(yield* Layer.build(FakeHost.layer()), FakeHost);
    const workspacePath = host.path('workspace');
    const session = yield* Effect.flatMap(
      TestSession.open(host.roots, { host: {} }),
      sessionHandleOf,
    );
    const approvalPolicy = (
      policy: Parameters<typeof setTestApprovalPolicy>[0],
    ) =>
      setTestApprovalPolicy(policy).pipe(Effect.provideService(FakeHost, host));
    yield* approvalPolicy('ask');
    const runId = yield* publishTestRunStart(session, generateRunId());
    yield* Context.get(session, SessionLog).settled;
    const decisions = yield* autoDecideRequests(session, decide);

    // The write side of both views the edit flow reaches: an absolute path
    // writes through the process `FileSystem`, a workspace-relative one
    // through the session's rooted `WorkspaceFs` view. One recorder serves
    // both, so a case asserts on what was applied either way.
    const writes: Array<{ target: string; content: string }> = [];
    const record = (target: string, content: Uint8Array) =>
      Effect.sync(() => {
        writes.push({
          target,
          content: Buffer.from(content).toString('utf-8'),
        });
      });
    // The workspace-relative half of the read side, which no real directory
    // backs.
    const relativeFiles = new Map<
      string,
      { exists: boolean; content: string }
    >();

    return {
      workspacePath,
      session,
      runId,
      approvalPolicy,
      writes,
      // The tool edits the run opened, as their rows reached the log.
      openedEdits: () =>
        decisions.opened.filter((event) => event.payload.kind === 'toolEdit'),
      // Seeds the file a tool edits: on disk for the edit flow's own read,
      // and in the rooted view a relative path resolves through. Whether the
      // run has read the file is a fact of its rows, seeded apart.
      stubWorkspaceFile: (
        filePath: string,
        options: { exists: boolean; content: string },
      ) => {
        const absolutePath = path.join(workspacePath, filePath);
        if (options.exists) {
          mkdirSync(path.dirname(absolutePath), { recursive: true });
          writeFileSync(absolutePath, options.content);
        }
        relativeFiles.set(filePath, options);
      },
      /**
       * Run a tool call with the exact per-call capabilities a dispatched
       * tool receives, over the stubbed halves of the edited files.
       */
      inRun: <A, E>(effect: Effect.Effect<A, E, PluginToolServices>) =>
        Effect.gen(function* () {
          const workspaceFs = yield* WorkspaceFs;
          const processFs = yield* FileSystem.FileSystem;
          return yield* effect.pipe(
            Effect.provideService(WorkspaceFs, {
              ...workspaceFs,
              exists: (target: string) =>
                Effect.succeed(relativeFiles.get(target)?.exists ?? false),
              readFile: (target: string) =>
                Effect.succeed(
                  Buffer.from(
                    relativeFiles.get(target)?.content ?? '',
                    'utf-8',
                  ),
                ),
              writeFile: record,
              makeDirectory: () => Effect.void,
            }),
            Effect.provideService(FileSystem.FileSystem, {
              ...processFs,
              writeFile: record,
              makeDirectory: () => Effect.void,
            }),
          );
        }).pipe(
          Effect.provide(
            nativeToolTestLayer({
              workingDirectory: workspacePath,
              run: { runId, session, toolPolicy: {} },
            }),
          ),
        ),
    };
  });

// Live clock: requests are opened and answered on the session's log.
layer(SessionGraph.hosted, { excludeTestServices: true })(
  'Tool edit approval gating',
  (it) => {
    it.effect('gates an edit to a dangling symlink as an existing file', () =>
      Effect.gen(function* () {
        const { workspacePath, inRun, writes, openedEdits } = yield* setUp();
        mkdirSync(workspacePath, { recursive: true });
        // A dangling symlink names a workspace entry even though stat through
        // the link fails; the read-before-edit gate must not treat it as new.
        symlinkSync(
          path.join(workspacePath, 'gone.txt'),
          path.join(workspacePath, 'dangling.txt'),
        );

        const result = yield* inRun(
          EditFileTool.call({
            path: 'dangling.txt',
            old_str: 'a',
            new_str: 'b',
          }),
        );

        assert.strictEqual(result.status, 'error');
        assert.match(result.error ?? '', /require a prior read/);
        assert.strictEqual(writes.length, 0);
        assert.strictEqual(openedEdits().length, 0);
      }),
    );

    it.effect('denies an edit under never, and tells the host', () =>
      Effect.gen(function* () {
        const {
          approvalPolicy,
          stubWorkspaceFile,
          inRun,
          writes,
          openedEdits,
        } = yield* setUp();
        yield* approvalPolicy('never');

        stubWorkspaceFile('denied.txt', { exists: false, content: '' });

        const result = yield* inRun(
          writeFileTool().call({ path: 'denied.txt', content: 'blocked' }),
        );

        assert.strictEqual(openedEdits().length, 0);
        assert.strictEqual(writes.length, 0);
        assert.strictEqual(result.status, 'error');
        assert.strictEqual(
          result.error,
          'Tool edit denied: write_file for denied.txt.\n\nDenied by the approval policy.',
        );
      }),
    );

    it.effect(
      "stores a pending edit's proposal with its request, where any process reads it",
      () =>
        Effect.gen(function* () {
          // Left pending: the proposal must be readable while nothing but the
          // rows holds it, as it is after the process that opened it is gone.
          const editOpened = yield* Deferred.make<void>();
          const { session, runId, inRun, openedEdits } = yield* setUp(() => {
            Deferred.doneUnsafe(editOpened, Effect.void);
            return null;
          });
          const request = yield* Effect.forkChild(
            inRun(
              requestToolEditApproval({
                path: 'draft.txt',
                originalContent: 'alpha\n',
                proposedContent: 'beta\n',
                sourceTool: 'write_file',
              }),
            ),
          );
          yield* Deferred.await(editOpened);
          const opened = openedEdits()[0];
          const address =
            opened.payload.kind === 'toolEdit'
              ? opened.payload.data.content
              : undefined;
          assert.ok(address, 'the request names its proposal by address');
          const stored = (yield* Context.get(session, SessionLog).blobs([
            address,
          ])).get(address);
          assert.ok(stored, 'the store holds the proposal under that address');
          const content: unknown = JSON.parse(stored);
          assert.ok(typeof content === 'object' && content !== null);
          assert.strictEqual(
            Reflect.get(content, 'originalContent'),
            'alpha\n',
          );
          assert.strictEqual(Reflect.get(content, 'proposedContent'), 'beta\n');
          // The door a surface reads the diff through answers from the store,
          // for a request its view lists: the log's tail above can see the
          // row before the view applies it.
          yield* Context.get(session, SessionLog).settled;
          const { preview } = yield* Context.get(session, SessionRequests)
            .request({
              kind: 'request.preview',
              runId,
              requestId: opened.requestId,
            })
            .pipe(Effect.provide(session));
          assert.deepStrictEqual(preview, content);
          yield* decideRequest(
            session,
            { runId, requestId: opened.requestId },
            { action: 'reject' },
          );
          assert.strictEqual((yield* Fiber.join(request)).action, 'reject');
        }),
    );
  },
);
