// Test composition imports
import '@test/support/defaultSessionTestSetup';

// Third-party imports
import { Deferred, Effect, Exit, type FileSystem, type Path } from 'effect';
import { describe, expect, it, onTestFinished, vi } from 'vitest';

// Local imports
import {
  ToolEditApprovalController,
  type ToolEditPreview,
  type ToolEditPreviewContext,
} from '@controllers/approval/ToolEditApprovalController';
import {
  aggregateId as qualifyAggregateId,
  RunIdSchema,
  type SessionEvent,
} from '@shared/schemas';
import { testRuntime } from '@test/support/testProcessRuntime';
import type {
  BuildDisplayFn,
  LatexPreviewEntry,
} from '@tools/approval/latexPreview';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { toolEditApprovalRequest } from '../agent/progressTestUtils';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

const RUN = RunIdSchema.parse('ab12cd');

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

vi.mock('@tools/approval/latexPreview', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tools/approval/latexPreview')>();
  return { ...actual, previewProposedLatex: latexPreview.previewProposedLatex };
});

function approvalRequest(): ToolEditApprovalRequest {
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
    ownerId: null,
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
  const contextReady = Deferred.makeUnsafe<void>();
  const previewPresented = Deferred.makeUnsafe<void>();
  const decided = Deferred.makeUnsafe<void>();
  const disposed = Deferred.makeUnsafe<void>();
  const preview = {
    originalPath: '/tmp/original.tex',
    proposedPath: '/tmp/proposed.tex',
    present: vi.fn(() => {
      Deferred.doneUnsafe(previewPresented, Effect.void);
      return Deferred.await(presentation);
    }),
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
    contextReady,
    previewPresented,
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
        Deferred.doneUnsafe(contextReady, Effect.void);
        return Deferred.await(staging).pipe(Effect.as(preview));
      },
      revealApprovalSurface: () => Effect.void,
      openBuildDisplay: (() => Effect.void) as BuildDisplayFn,
      reportError: vi.fn(),
      decide: vi.fn(() => {
        Deferred.doneUnsafe(decided, Effect.void);
        return Effect.void;
      }),
    },
  };
}

function createController(host: ReturnType<typeof createTestHost>['host']) {
  const controller = new ToolEditApprovalController({ host });
  onTestFinished(() => run(controller.dispose()));
  return controller;
}

describe('tool edit approval controller', () => {
  it('holds a release open until the staging in flight has disposed', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    const presented = run(controller.present(approvalRequest()));
    await run(Deferred.await(testHost.contextReady));
    const requestId = testHost.contextForRequest().requestId;

    // The `request.opened` commit was refused while the host was still
    // staging, so the release runs with a preview in flight: it may not
    // settle before that preview is disposed, or the caller it answers
    // would report the refusal with temp files still being written.
    let released = false;
    const release = run(controller.release(requestId)).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);
    expect(testHost.preview.dispose).not.toHaveBeenCalled();

    Deferred.doneUnsafe(testHost.staging, Effect.void);
    await release;
    expect(released).toBe(true);
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();

    await presented;
    expect(testHost.preview.present).not.toHaveBeenCalled();
  });

  it('holds a release open until the view being opened has disposed', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    const presented = run(controller.present(approvalRequest()));
    await run(Deferred.await(testHost.contextReady));
    const requestId = testHost.contextForRequest().requestId;

    // Staging finished, so the request is staged and the host is opening its
    // view on the staged files. A release now may not settle before that view
    // is open and closed again: closing it is what the release is for.
    Deferred.doneUnsafe(testHost.staging, Effect.void);
    await run(Deferred.await(testHost.previewPresented));
    expect(testHost.preview.present).toHaveBeenCalledOnce();

    let released = false;
    const release = run(controller.release(requestId)).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);
    expect(testHost.preview.dispose).not.toHaveBeenCalled();

    Deferred.doneUnsafe(testHost.presentation, Effect.void);
    await release;
    expect(released).toBe(true);
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();

    // Nothing opens a view after the release settled.
    await presented;
    expect(testHost.preview.present).toHaveBeenCalledOnce();
    expect(testHost.preview.showDiff).not.toHaveBeenCalled();
  });

  it('joins a second release to the cleanup the first one is running', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);
    const disposal = Deferred.makeUnsafe<void>();
    testHost.preview.dispose.mockImplementation(() => Deferred.await(disposal));

    Deferred.doneUnsafe(testHost.staging, Effect.void);
    Deferred.doneUnsafe(testHost.presentation, Effect.void);
    await run(controller.present(approvalRequest()));
    const requestId = testHost.contextForRequest().requestId;

    // `dispose` admits a release for every staged request before it waits on
    // any, and the host's release for a refused `request.opened` lands right
    // behind it: the second one finds the entry already dropped, so it has
    // only the cleanup in flight to wait for. Both settle once it is gone.
    let disposed = false;
    const disposing = run(controller.dispose()).then(() => {
      disposed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    let released = false;
    const release = run(controller.release(requestId)).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(disposed).toBe(false);
    expect(released).toBe(false);

    Deferred.doneUnsafe(disposal, Effect.void);
    await Promise.all([disposing, release]);
    expect(disposed).toBe(true);
    expect(released).toBe(true);
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();
  });

  it('ignores actions that arrive after the request was decided', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);

    Deferred.doneUnsafe(testHost.staging, Effect.void);
    Deferred.doneUnsafe(testHost.presentation, Effect.void);
    await run(controller.present(approvalRequest()));
    const requestId = testHost.contextForRequest().requestId;
    expect(testHost.preview.present).toHaveBeenCalled();

    await run(controller.handleAction({ requestId, action: 'approve' }));
    await run(Deferred.await(testHost.decided));
    expect(testHost.host.decide).toHaveBeenCalledWith(RUN, requestId, {
      action: 'approve',
      content: 'edited by the user',
    });

    // The fold's answer releases the preview; nothing acts on it afterwards.
    await run(controller.handleSessionEvent(decided(requestId)));
    await run(Deferred.await(testHost.disposed));
    expect(testHost.preview.dispose).toHaveBeenCalledOnce();

    await run(controller.handleAction({ requestId, action: 'openDiff' }));
    await run(controller.handleAction({ requestId, action: 'reject' }));
    await Promise.resolve();

    expect(testHost.preview.showDiff).not.toHaveBeenCalled();
    expect(testHost.host.decide).toHaveBeenCalledOnce();
  });

  it('holds a release until a preview build still running has settled, and starts no build for a settled request', async () => {
    const testHost = createTestHost();
    const controller = createController(testHost.host);
    const events: string[] = [];
    const builds: Deferred.Deferred<void, Error>[] = [];
    // The host build is a program now, and its own settlement is what a
    // release waits for, so the event it records belongs inside it.
    const firstBuildStarted = Deferred.makeUnsafe<void>();
    const secondBuildStarted = Deferred.makeUnsafe<void>();
    const openBuildDisplay = vi.fn(() => {
      const build = Deferred.makeUnsafe<void, Error>();
      builds.push(build);
      Deferred.doneUnsafe(
        builds.length === 1 ? firstBuildStarted : secondBuildStarted,
        Effect.void,
      );
      return Deferred.await(build).pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            events.push(Exit.isSuccess(exit) ? 'build-done' : 'build-failed');
          }),
        ),
      );
    });
    testHost.host.openBuildDisplay = openBuildDisplay;
    testHost.preview.dispose.mockImplementation(() =>
      Effect.sync(() => {
        events.push('dispose');
      }),
    );
    const diffLocation = {
      kind: 'external',
      absolutePath: '/tmp/diff.pdf',
    } as const;
    latexPreview.previewProposedLatex.mockImplementation(
      (
        entry: LatexPreviewEntry,
        options: { openBuildDisplay: BuildDisplayFn },
      ) => {
        latexPreview.injectedOptions.push(options);
        return Effect.gen(function* () {
          entry.workspaceTempCleanup.push(
            Effect.sync(() => {
              events.push('temp-cleanup');
            }),
          );
          // Started and left running, which is what the real program's settle
          // race produces: the fiber that yielded the display is interrupted
          // and the host build keeps going with nobody holding it. A failed
          // build is reported by the program that started it, so it is
          // absorbed here rather than escaping the display program.
          yield* Effect.forkDetach(
            options
              .openBuildDisplay(diffLocation)
              .pipe(Effect.catchCause(() => Effect.void)),
          );
        });
      },
    );

    Deferred.doneUnsafe(testHost.staging, Effect.void);
    Deferred.doneUnsafe(testHost.presentation, Effect.void);
    await run(controller.present(approvalRequest()));
    const requestId = testHost.contextForRequest().requestId;

    await run(
      controller.handleAction({ requestId, action: 'previewProposed' }),
    );
    await run(Deferred.await(firstBuildStarted));
    expect(openBuildDisplay).toHaveBeenCalledOnce();

    // The build is still running, so a release may not settle yet: the
    // release deletes the temp files the build is reading.
    let released = false;
    const release = run(controller.release(requestId)).then(() => {
      released = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(released).toBe(false);
    expect(testHost.preview.dispose).not.toHaveBeenCalled();
    expect(events).toEqual([]);

    Deferred.doneUnsafe(builds[0], Effect.void);
    await release;
    expect(released).toBe(true);
    // The build settles before the release touches what it was reading.
    expect(events).toEqual(['build-done', 'dispose', 'temp-cleanup']);

    // A settle stops admission: the callback the program already holds opens
    // no second build for a request nobody is looking at.
    await run(latexPreview.injectedOptions[0].openBuildDisplay(diffLocation));
    expect(openBuildDisplay).toHaveBeenCalledOnce();

    // A build that fails settles too, so a release joins that one as well
    // rather than hanging, and the failure stays on the program's own error
    // path instead of escaping the display callback.
    await run(controller.present(approvalRequest()));
    const secondRequestId = testHost.contextForRequest().requestId;
    await run(
      controller.handleAction({
        requestId: secondRequestId,
        action: 'previewProposed',
      }),
    );
    await run(Deferred.await(secondBuildStarted));
    expect(openBuildDisplay).toHaveBeenCalledTimes(2);

    const secondRelease = run(controller.release(secondRequestId));
    Deferred.doneUnsafe(builds[1], Effect.fail(new Error('the build failed')));
    await secondRelease;
    expect(events).toEqual([
      'build-done',
      'dispose',
      'temp-cleanup',
      'build-failed',
      'dispose',
      'temp-cleanup',
    ]);
  });
});
