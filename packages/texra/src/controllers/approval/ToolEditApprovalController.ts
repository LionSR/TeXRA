/**
 * Host-neutral tool-edit preview controller.
 *
 * One controller per window follows its session's pending tool-edit
 * requests. For each, the host stages the original and proposed content as
 * the files its diff view shows, for as long as the view lists the request.
 * The content and the user's edit of it are the session's
 * (`request.preview`, `request.edit`), so any window of the project shows
 * the same edit and an approval from anywhere applies it; the decision is
 * the request's `request.decide`. Everything a host owns (staging the files,
 * its diff view, reading back what the user typed) lives behind
 * {@link ToolEditApprovalHost}.
 *
 * Each request's preview lives in a scope of its own, closed when the view
 * drops the request or the window goes. Closing it interrupts what the user
 * started on it (a LaTeX preview stops its subprocess), waits for a host
 * build still reading the staged files, and then removes them.
 */
import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  type FileSystem,
  type Path,
  Scope,
  Stream,
} from 'effect';

import {
  type HostRequestFailure,
  type Session,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import { withLogChannel } from '@texra-ai/harness/host';
import {
  toErrorMessage,
  type PendingRequest,
  type ToolEditContent,
  type ToolEditPermission,
} from '@texra-ai/harness/schemas';
import { followPendingRequests } from '@texra/controllers/session/followPendingRequests';
import { isLatexFile } from '@texra/shared/latexFileTypes';
import type { HostRequest } from '@texra/shared/session/hostRequest';
import {
  previewProposedLatex,
  runLatexdiff,
  type BuildDisplayFn,
  type LatexPreviewEntry,
} from '@texra/tools/latex/latexPreview';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const CHANNEL = 'ToolEditApproval';

/**
 * Runtime services this controller's programs take: preview programs stage
 * temp files and the host build spawns the compiler. A host provides them
 * once, where it forks {@link ToolEditApprovalController.follow}.
 */
type PreviewServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner;
type PreviewCall<A> = Effect.Effect<A, HostRequestFailure, PreviewServices>;

/** A pending tool edit as a host stages it: its prompt and its content. */
export type ToolEditPreviewRequest = ToolEditPermission & ToolEditContent;

/** The host view of one staged request, live until its scope closes. */
export interface ToolEditPreview {
  readonly originalPath: string;
  readonly proposedPath: string;
  /** Open the host's diff view, or bring it back after the user closed it. */
  showDiff(): PreviewCall<void>;
  /** Open the proposed copy in the host's plain file viewer. */
  openProposed(): PreviewCall<void>;
  /** Proposed content including edits the user made in the host's view. */
  readProposedContent(): PreviewCall<string>;
  /** The proposed content each time the user edits it. */
  readonly edits: Stream.Stream<string, never, PreviewServices>;
  /** Close the view and remove everything staged for this request. */
  dispose(): PreviewCall<void>;
}

export interface ToolEditApprovalHost {
  /** Materialize the original and proposed content for the host's view. */
  stagePreview(request: ToolEditPreviewRequest): PreviewCall<ToolEditPreview>;
  /** The host's build display, which the LaTeX preview programs yield. */
  readonly openBuildDisplay: BuildDisplayFn;
  reportError(message: string): void;
  /** Whether the user works in this window now: only that window opens a
   *  new request's diff on its own. */
  focused(): boolean;
}

interface ToolEditApprovalControllerOptions {
  host: ToolEditApprovalHost;
  /** The session whose requests this window shows: here, or the service's. */
  session: Pick<Session, 'request' | 'view'>;
  /** The window's roots, which the LaTeX previews' temp files go under. */
  roots: WorkspaceRoots;
}

/** One staged request, for its scope's life. */
interface StagedPreview extends LatexPreviewEntry {
  readonly pending: PendingRequest;
  readonly preview: ToolEditPreview;
  readonly scope: Scope.Scope;
  /** The proposed content as this window last told the session, so an
   *  untouched buffer never replaces another window's edit. */
  sent: string;
}

type ToolEditRequest = PendingRequest & {
  readonly payload: {
    readonly kind: 'toolEdit';
    readonly data: ToolEditPermission;
  };
};

const isToolEdit = (request: PendingRequest): request is ToolEditRequest =>
  request.payload.kind === 'toolEdit';

export class ToolEditApprovalController {
  /** The requests staged in this window, each held by its scope. */
  private readonly staged = new Map<string, StagedPreview>();

  constructor(private readonly options: ToolEditApprovalControllerOptions) {}

  /** Stage every pending tool edit the session lists, until interrupted. */
  readonly follow: Effect.Effect<void, never, PreviewServices> = Effect.scoped(
    followPendingRequests(this.options.session.view, isToolEdit, (pending) =>
      Effect.scoped(this.stage(pending)).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : this.report(cause).pipe(Effect.andThen(Effect.never)),
        ),
      ),
    ),
  );

  handleAction(
    payload: Pick<
      Extract<HostRequest, { kind: 'toolEdit' }>,
      'requestId' | 'action'
    >,
  ): Effect.Effect<void, never, PreviewServices> {
    return Effect.suspend(() => {
      const entry = this.staged.get(payload.requestId);
      if (entry === undefined) {
        // Nothing staged here: an approval decides from the payload, which
        // applies the edit the session holds, if any.
        if (payload.action !== 'approve') return Effect.void;
        const pending = this.options.session.view
          .current()
          .requests.find((r) => r.requestId === payload.requestId);
        return pending === undefined
          ? Effect.void
          : this.decide(pending).pipe(Effect.catch((e) => this.report(e)));
      }
      const action = (): PreviewCall<void> => {
        switch (payload.action) {
          case 'approve':
            return this.approve(entry);
          case 'openDiff':
            return Effect.uninterruptible(entry.preview.showDiff());
          case 'previewProposed':
            return isLatexFile(entry.request.path)
              ? previewProposedLatex(entry, {
                  openBuildDisplay: this.buildDisplayFor(entry),
                })
              : Effect.uninterruptible(entry.preview.openProposed());
          case 'showLatexdiff':
            // ONLYCHANGEDPAGE keeps a tool-edit diff focused on the changes.
            return runLatexdiff(entry, {
              subtype: 'ONLYCHANGEDPAGE',
              openBuildDisplay: this.buildDisplayFor(entry),
            });
        }
      };
      // In the request's scope: the scope's close interrupts it and waits.
      return Effect.forkIn(
        Effect.suspend(action).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause) ? Effect.void : this.report(cause),
          ),
        ),
        entry.scope,
      ).pipe(Effect.asVoid);
    });
  }

  /** Stage one request, show it when this window is focused, and hold it
   *  until its scope closes. */
  private stage(
    pending: ToolEditRequest,
  ): Effect.Effect<never, HostRequestFailure, PreviewServices | Scope.Scope> {
    const { session, host, roots } = this.options;
    const { runId, requestId } = pending;
    return Effect.gen({ self: this }, function* () {
      const outcome = yield* session.request({
        kind: 'request.preview',
        runId,
        requestId,
      });
      if (outcome.kind !== 'preview' || outcome.preview === null) {
        // The card still answers from its payload; there is no diff to show.
        yield* Effect.logWarning(
          `The session holds no preview of tool edit ${requestId}`,
        ).pipe(withLogChannel(CHANNEL));
        return yield* Effect.never;
      }
      // What the user edited, in this window or one that went before it,
      // is what this window's proposed side shows.
      const { edited, ...content } = outcome.preview;
      const proposedContent = edited ?? content.proposedContent;
      const scope = yield* Scope.Scope;
      const settled = yield* Deferred.make<void>();
      const workspaceTempCleanup: StagedPreview['workspaceTempCleanup'] = [];
      const preview = yield* Effect.acquireRelease(
        host.stagePreview({
          ...pending.payload.data,
          ...content,
          proposedContent,
        }),
        // The files the LaTeX previews wrote go even when the view's close
        // fails, as it can at window teardown.
        (staged) =>
          staged.dispose().pipe(
            Effect.ensuring(
              Effect.all(workspaceTempCleanup, { discard: true }),
            ),
            Effect.catch((error) => this.report(error)),
          ),
      );
      const entry: StagedPreview = {
        pending,
        scope,
        preview,
        request: { path: pending.payload.data.path, roots },
        originalUri: { fsPath: preview.originalPath },
        proposedUri: { fsPath: preview.proposedPath },
        originalContent: content.originalContent,
        proposedContent,
        isSettled: () => Deferred.isDoneUnsafe(settled),
        settled,
        workspaceTempCleanup,
        latexOperationInProgress: false,
        onError: (message) => host.reportError(message),
        sent: proposedContent,
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => this.staged.set(requestId, entry)),
        () =>
          Effect.sync(() => {
            this.staged.delete(requestId);
            Deferred.doneUnsafe(settled, Effect.void);
          }),
      );
      // A window that goes while the request still waits leaves the user's
      // last buffer with the session, where the next window picks it up.
      yield* Effect.addFinalizer(() =>
        session.view
          .current()
          .requests.some((request) => request.requestId === requestId)
          ? entry.preview.readProposedContent().pipe(
              Effect.flatMap((edited) => this.edit(entry, edited)),
              Effect.catch((error) =>
                Effect.logWarning(
                  `The edit of tool edit ${requestId} did not reach the session as its window closed: ${toErrorMessage(error)}`,
                ).pipe(withLogChannel(CHANNEL)),
              ),
            )
          : Effect.void,
      );
      yield* Effect.forkScoped(
        Stream.runForEach(entry.preview.edits, (edited) =>
          this.edit(entry, edited).pipe(
            Effect.catch((error) => this.report(error)),
          ),
        ),
      );
      if (host.focused())
        yield* Effect.uninterruptible(entry.preview.showDiff()).pipe(
          Effect.catch((error) => this.report(error)),
        );
      return yield* Effect.never;
    });
  }

  /** Approve as the Approve button does: the document as the user left it
   *  in this view becomes the session's edit, which the approval applies. */
  private approve(entry: StagedPreview): PreviewCall<void> {
    return entry.preview.readProposedContent().pipe(
      Effect.flatMap((edited) => this.edit(entry, edited)),
      Effect.andThen(this.decide(entry.pending)),
    );
  }

  /** Tell the session the user's edit, when this view changed it. */
  private edit(
    entry: StagedPreview,
    content: string,
  ): Effect.Effect<void, HostRequestFailure> {
    if (content === entry.sent) return Effect.void;
    const { runId, requestId } = entry.pending;
    return this.options.session
      .request({ kind: 'request.edit', runId, requestId, content })
      .pipe(
        Effect.andThen(
          Effect.sync(() => {
            entry.sent = content;
          }),
        ),
      );
  }

  private decide(
    pending: PendingRequest,
  ): Effect.Effect<void, HostRequestFailure> {
    const { runId, requestId } = pending;
    return this.options.session
      .request({
        kind: 'request.decide',
        runId,
        requestId,
        decision: { action: 'approve' },
      })
      .pipe(Effect.asVoid);
  }

  /** The display program the LaTeX previews get for one entry: the host's
   *  build runs to its end, in the request's scope, so its close waits for
   *  it rather than delete the files it reads. */
  private buildDisplayFor(entry: StagedPreview): BuildDisplayFn {
    return (location, options) =>
      Effect.forkIn(
        Effect.uninterruptible(
          this.options.host.openBuildDisplay(location, options),
        ),
        entry.scope,
      ).pipe(Effect.flatMap(Fiber.join));
  }

  private report(failure: unknown): Effect.Effect<void> {
    return Effect.sync(() =>
      this.options.host.reportError(
        toErrorMessage(
          Cause.isCause(failure) ? Cause.squash(failure) : failure,
        ),
      ),
    );
  }
}
