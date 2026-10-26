// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { Deferred, Effect, type FileSystem, type Path, Schema } from 'effect';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

// Local imports
import {
  qualifyAggregateId,
  RunIdSchema,
  type SessionEvent,
} from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import {
  ToolEditApprovalController,
  type ToolEditPreview,
  type ToolEditPreviewContext,
} from '@texra/controllers/approval/ToolEditApprovalController';
import type { BuildDisplayFn } from '@texra/tools/latex/latexPreview';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { toolEditApprovalRequest } from '../agent/progressTestUtils';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const RUN = Schema.decodeUnknownSync(RunIdSchema)('ab12cd');

/** The controller's verbs are Effects; this is the host wiring point's run. */
function run<A, E>(
  program: Effect.Effect<
    A,
    E,
    FileSystem.FileSystem | Path.Path | ChildProcessSpawner
  >,
): Promise<A> {
  return testRuntime().runPromise(program);
}

/**
 * The preview program the controller runs for a LaTeX proposal, replaced so a
 * test can hand the controller's injected display callback a build it holds
 * open. The override starts that build and completes without awaiting it,
 * which is what the real program's settle race produces: the fiber running it
 * is interrupted and the host build keeps going with nobody holding it.
 */
const latexPreview = vi.hoisted(() => ({
  previewProposedLatex: vi.fn(),
  /** The options each call received, so a test can reuse the callback. */
  injectedOptions: [] as Array<{ openBuildDisplay: BuildDisplayFn }>,
}));

vi.mock('@texra/tools/latex/latexPreview', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@texra/tools/latex/latexPreview')>();
  return { ...actual, previewProposedLatex: latexPreview.previewProposedLatex };
});

function approvalRequest() {
  return toolEditApprovalRequest({
    path: '/workspace/paper.tex',
    originalContent: 'old',
    proposedContent: 'new',
    sourceTool: 'edit_file',
    runId: RUN,
  });
}

/** The fold's answer to a request, as the plane hands it to the controller. */
function decided(requestId: string): SessionEvent {
  return {
    type: 'request.decided',
    aggregateId: qualifyAggregateId('run', RUN),
    requestId,
    decision: { action: 'approve' },
    seq: 1,
    commit: 1,
    origin: null,
    at: 0,
  };
}

/**
 * A host whose staging and whose view opening can each be held open, so a
 * test can act on a request while it is still initializing, and again while
 * the host is presenting the request it staged.
 */
function createTestHost() {
  const staging = Deferred.makeUnsafe<void>();
  const presentation = Deferred.makeUnsafe<void>();
  const decided = Deferred.makeUnsafe<void>();
  const disposed = Deferred.makeUnsafe<void>();
  const preview = {
    originalPath: '/tmp/original.tex',
    proposedPath: '/tmp/proposed.tex',
    present: vi.fn(() => Deferred.await(presentation)),
    showDiff: vi.fn(() => Effect.void),
    openProposed: vi.fn(() => Effect.void),
    readProposedContent: vi.fn(() => Effect.succeed('edited by the user')),
    dispose: vi.fn(() => {
      Deferred.doneUnsafe(disposed, Effect.void);
      return Effect.void;
    }),
  } satisfies ToolEditPreview;
  let context: ToolEditPreviewContext | undefined;
  return {
    staging,
    presentation,
    decided,
    disposed,
    preview,
    contextForRequest: (): ToolEditPreviewContext => {
      if (!context) throw new Error('stagePreview has not been called yet.');
      return context;
    },
    host: {
      stagePreview: (
        _request: ToolEditApprovalRequest,
        previewContext: ToolEditPreviewContext,
      ) => {
        context = previewContext;
        return Deferred.await(staging).pipe(Effect.as(preview));
      },
      openBuildDisplay: (() => Effect.void) as BuildDisplayFn,
      reportError: vi.fn(),
    },
    session: {
      request: vi.fn(() => {
        Deferred.doneUnsafe(decided, Effect.void);
        return Effect.succeed({ kind: 'done' as const });
      }),
    },
  };
}

function createController(testHost: ReturnType<typeof createTestHost>) {
  const { host, session } = testHost;
  const controller = new ToolEditApprovalController({ host, session });
  onTestFinished(() => run(controller.dispose()));
  return controller;
}

describe('tool edit approval controller', () => {
  it('ignores actions that arrive after the request was decided', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost);

    Deferred.doneUnsafe(testHost.staging, Effect.void);
    Deferred.doneUnsafe(testHost.presentation, Effect.void);
    await run(
      Effect.flatMap(approvalRequest(), (request) =>
        controller.present(request),
      ),
    );
    const requestId = testHost.contextForRequest().requestId;
    expect(testHost.preview.present).toHaveBeenCalled();

    await run(controller.handleAction({ requestId, action: 'approve' }));
    await run(Deferred.await(testHost.decided));
    expect(testHost.session.request).toHaveBeenCalledWith({
      kind: 'request.decide',
      runId: RUN,
      requestId,
      decision: { action: 'approve', content: 'edited by the user' },
    });

    // The fold's answer releases the preview; nothing acts on it afterwards.
    await run(controller.handleSessionEvent(decided(requestId)));
    await run(Deferred.await(testHost.disposed));
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();

    await run(controller.handleAction({ requestId, action: 'openDiff' }));
    await run(controller.handleAction({ requestId, action: 'approve' }));
    await Promise.resolve();

    expect(testHost.preview.showDiff).not.toHaveBeenCalled();
    expect(testHost.session.request).toHaveBeenCalledOnce();
  });
});
