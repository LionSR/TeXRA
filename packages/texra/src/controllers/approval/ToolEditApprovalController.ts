/**
 * Host-neutral tool-edit preview controller.
 *
 * One controller per window follows its session's pending tool-edit
 * requests. For each, the host stages the original and proposed content as
 * the files its diff view shows, for as long as the view lists the request.
 * The content is the request's (`request.preview`), so every window of the
 * project shows the same proposal, and no window changes it; what the user
 * types into the proposed side is this window's until its Approve sends it
 * as the decision's content (`request.decide`), which the tool applies. The
 * session records one decision per request: an Approve sent after another
 * window answered is refused, never applied over that answer. Everything a
 * host owns (staging the files, its diff view, reading back what the user
 * typed) lives behind {@link ToolEditApprovalHost}.
 *
 * Each request's preview lives in a scope of its own, closed when the view
 * drops the request or the window goes. Closing it interrupts what the user
 * started on it (a LaTeX preview stops its subprocess), waits for a host
 * build still reading the staged files and for an approval still on its
 * way, and then removes them. A request that ended without the proposed
 * side as the user left it here (another window or the terminal answered
 * it, a session approval or a stop decided it) leaves that text with the
 * host, which keeps it where the user can reach it and says so; a copy the
 * user never changed just goes. A window that goes while the request still
 * waits takes its edits with it.
 */
import {
  Cause,
  Effect,
  Fiber,
  type FileSystem,
  type Path,
  Ref,
  Scope,
  Semaphore,
} from 'effect';

import {
  type OutcomeOf,
  type Session,
  type WorkspaceRoots,
} from '@texra-ai/harness';
import { followPendingRequests } from '@texra-ai/harness/host';
import { withLogChannel } from '@texra-ai/harness/plugins';
import {
  toErrorMessage,
  type PendingRequest,
  type RunId,
  type ToolEditContent,
  type ToolEditRequest,
  type RuntimeCommand,
} from '@texra-ai/harness/schemas';
import { HostFailed } from '@texra/hosts/uiHosts';
import { isLatexFile } from '@texra/shared/latexFileTypes';
import type { HostCommand } from '@texra/shared/session/hostRequest';
import {
  previewProposedLatex,
  runLatexdiff,
  type BuildDisplayFn,
  type LatexPreviewEntry,
} from '@texra/tools/latex/latexPreview';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';
import { type HostCommandFailure } from '@texra/controllers/session/hostCallFailure';

const CHANNEL = 'ToolEditApproval';

/**
 * Runtime services this controller's programs take: preview programs stage
 * temp files and the host build spawns the compiler. A host provides them
 * once, where it forks {@link ToolEditApprovalController.follow}.
 */
type PreviewServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner;
type PreviewCall<A> = Effect.Effect<A, HostCommandFailure, PreviewServices>;
/** An approval's session bypass, sent with its `request.decide`. */
type Grant = Extract<HostCommand, { kind: 'toolEdit' }>['grant'];

/** What a tool edit's prompt shows: the session's preview of the edit, or
 *  why there is none. No surface stands an empty diff in for a missing
 *  preview: the user would approve a write they never saw. */
export type ToolEditPreviewRead =
  | { readonly kind: 'preview'; readonly content: ToolEditContent }
  | { readonly kind: 'unavailable'; readonly reason: string };

/**
 * Read a pending tool edit's preview from the session holding it, as every
 * surface does before it shows the prompt. A session that does not send it
 * and one that holds none are the same answer for the prompt: no diff, with
 * the reason, logged here once.
 */
export function readToolEditPreview(
  session: {
    readonly request: (
      request: Extract<RuntimeCommand, { kind: 'request.preview' }>,
    ) => Effect.Effect<OutcomeOf<'request.preview'>, Error>;
  },
  runId: RunId,
  requestId: string,
): Effect.Effect<ToolEditPreviewRead> {
  const unavailable = (reason: string) =>
    Effect.logWarning(`No preview of tool edit ${requestId}: ${reason}`).pipe(
      withLogChannel(CHANNEL),
      Effect.andThen(
        Effect.succeed<ToolEditPreviewRead>({ kind: 'unavailable', reason }),
      ),
    );
  return session.request({ kind: 'request.preview', runId, requestId }).pipe(
    Effect.flatMap(({ preview }) =>
      preview === null
        ? unavailable('the session holds no preview of this edit')
        : Effect.succeed<ToolEditPreviewRead>({
            kind: 'preview',
            content: preview,
          }),
    ),
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : unavailable(
            `the session did not send it (${toErrorMessage(Cause.squash(cause))})`,
          ),
    ),
  );
}

type PendingToolEdit = PendingRequest & {
  readonly payload: {
    readonly kind: 'toolEdit';
    readonly data: ToolEditRequest;
  };
};

const isToolEdit = (request: PendingRequest): request is PendingToolEdit =>
  request.payload.kind === 'toolEdit';

/**
 * Follow the pending tool edits `session` lists, until interrupted: read
 * each one's preview once, and keep what `show` puts up with it until the
 * view drops the request, however it was decided. `show` runs in a scope of
 * the request's own, which closes then and releases what it holds.
 */
export const followToolEditPreviews = <R>(
  session: Pick<Session, 'request'> & {
    readonly view: Pick<Session['view'], 'changes'>;
  },
  show: (
    pending: PendingToolEdit,
    read: ToolEditPreviewRead,
  ) => Effect.Effect<void, never, R>,
): Effect.Effect<void, never, Exclude<R, Scope.Scope>> =>
  Effect.scoped(
    followPendingRequests(
      session.view,
      (view) => view.requests.filter(isToolEdit),
      (pending) =>
        Effect.scoped(
          readToolEditPreview(session, pending.runId, pending.requestId).pipe(
            Effect.flatMap((read) => show(pending, read)),
            Effect.andThen(Effect.never),
          ),
        ),
    ),
  );

/** A pending tool edit as a host stages it: its prompt and its content. */
export type ToolEditPreviewRequest = ToolEditRequest & ToolEditContent;

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
  /**
   * Close the view and remove everything staged for this request. When the
   * request ended without the proposed content as the user left it here,
   * that content is `unapplied`: the host keeps it where the user can still
   * reach it, and tells the user it was not applied and where it is.
   */
  dispose(unapplied?: string): PreviewCall<void>;
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
  /** Whether the session recorded this window's approval, which carried
   *  the proposed content as the user left it here. */
  readonly applied: Ref.Ref<boolean>;
}

export class ToolEditApprovalController {
  /** The requests staged in this window, each held by its scope. */
  private readonly staged = new Map<string, StagedPreview>();

  private readonly options: ToolEditApprovalControllerOptions;
  constructor(options: ToolEditApprovalControllerOptions) {
    this.options = options;
  }

  /** Stage every pending tool edit the session lists, until interrupted. */
  get follow(): Effect.Effect<void, never, PreviewServices> {
    return followToolEditPreviews(this.options.session, (pending, read) =>
      this.stage(pending, read).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : this.report(cause),
        ),
      ),
    );
  }

  handleAction(
    payload: Pick<
      Extract<HostCommand, { kind: 'toolEdit' }>,
      'requestId' | 'action' | 'grant'
    >,
  ): Effect.Effect<void, never, PreviewServices> {
    return Effect.suspend(() => {
      const entry = this.staged.get(payload.requestId);
      if (entry === undefined) {
        // Nothing staged here: an approval decides from the payload, which
        // applies the proposal.
        if (payload.action !== 'approve') return Effect.void;
        const pending = this.options.session.view
          .current()
          .requests.find((r) => r.requestId === payload.requestId);
        return pending === undefined
          ? Effect.void
          : this.decide(pending, payload.grant).pipe(
              Effect.catch((e) => this.report(e)),
            );
      }
      const action = (): PreviewCall<void> => {
        switch (payload.action) {
          case 'approve':
            return this.approve(entry, payload.grant);
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
      const program = Effect.suspend(action).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : this.report(cause),
        ),
      );
      // In the request's scope: the scope's close interrupts it and waits.
      // An approval runs to its answer, which the close then reads: the
      // view can drop the request (this approval recorded, or another
      // window's) before the answer comes back.
      return Effect.forkIn(
        payload.action === 'approve'
          ? Effect.uninterruptible(program)
          : program,
        entry.scope,
      ).pipe(Effect.asVoid);
    });
  }

  /** Stage one request in its scope and show it when this window is
   *  focused; the scope's close removes it. */
  private stage(
    pending: PendingToolEdit,
    read: ToolEditPreviewRead,
  ): Effect.Effect<void, HostCommandFailure, PreviewServices | Scope.Scope> {
    const { host, roots } = this.options;
    const { requestId } = pending;
    return Effect.gen({ self: this }, function* () {
      if (read.kind === 'unavailable') {
        // The card still answers from its payload; there is no diff to show.
        host.reportError(
          `No diff of the edit to ${pending.payload.data.relativePath}: ${read.reason}.`,
        );
        return;
      }
      const content = read.content;
      const scope = yield* Scope.Scope;
      const applied = yield* Ref.make(false);
      // The LaTeX previews' temp files go with this child scope. Forked
      // first, it closes last: after the previews and the builds that read
      // those files have stopped, and after the view's close, even when
      // that fails, as it can at window teardown.
      const files = yield* Scope.fork(scope);
      const preview = yield* Effect.acquireRelease(
        host.stagePreview({ ...pending.payload.data, ...content }),
        (staged) =>
          this.unapplied(
            pending,
            staged,
            content.proposedContent,
            applied,
          ).pipe(
            Effect.flatMap((unapplied) => staged.dispose(unapplied)),
            Effect.catch((error) => this.report(error)),
          ),
      );
      const entry: StagedPreview = {
        pending,
        scope,
        preview,
        applied,
        request: { path: pending.payload.data.path, roots },
        originalUri: { fsPath: preview.originalPath },
        proposedUri: { fsPath: preview.proposedPath },
        originalContent: content.originalContent,
        proposedContent: content.proposedContent,
        files,
        operation: yield* Semaphore.make(1),
        onError: (message) => host.reportError(message),
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => this.staged.set(requestId, entry)),
        () => Effect.sync(() => this.staged.delete(requestId)),
      );
      if (host.focused())
        yield* Effect.uninterruptible(entry.preview.showDiff()).pipe(
          Effect.catch((error) => this.report(error)),
        );
    });
  }

  /** Approve as the Approve button does: the document as the user left it
   *  in this view goes with the decision, which applies it. */
  private approve(entry: StagedPreview, grant?: Grant): PreviewCall<void> {
    return entry.preview.readProposedContent().pipe(
      Effect.flatMap((content) => this.decide(entry.pending, grant, content)),
      Effect.andThen(Ref.set(entry.applied, true)),
    );
  }

  /**
   * The proposed content as the user left it in this window, when its
   * request ended without it: the session recorded no approval from here,
   * and the user changed the proposal. None while the view still lists the
   * request, which is this window going; its edits go with it. A copy that
   * cannot be read may hold the user's edits, so the read fails the release
   * before its dispose: the staged files stay, and the report names where.
   */
  private readonly unapplied: (
    pending: PendingToolEdit,
    preview: ToolEditPreview,
    proposal: string,
    applied: Ref.Ref<boolean>,
  ) => PreviewCall<string | undefined> = Effect.fn(
    'ToolEditApprovalController.unapplied',
  )(
    { self: this },
    function* (
      pending: PendingToolEdit,
      preview: ToolEditPreview,
      proposal: string,
      applied: Ref.Ref<boolean>,
    ) {
      if (yield* Ref.get(applied)) return undefined;
      const listed = this.options.session.view
        .current()
        .requests.some(
          (r) => r.runId === pending.runId && r.requestId === pending.requestId,
        );
      if (listed) return undefined;
      const left = yield* preview.readProposedContent().pipe(
        Effect.mapError(
          (cause) =>
            new HostFailed({
              member: 'readProposedContent',
              message: `${toErrorMessage(cause)} The proposed ${pending.payload.data.path} as you left it is kept at ${preview.proposedPath}.`,
              cause,
            }),
        ),
      );
      // A host may read its copy back with CRLF line ends.
      return left.replaceAll('\r\n', '\n') === proposal.replaceAll('\r\n', '\n')
        ? undefined
        : left;
    },
  );

  private decide(
    pending: PendingRequest,
    grant?: Grant,
    content?: string,
  ): Effect.Effect<void, HostCommandFailure> {
    const { runId, requestId } = pending;
    return this.options.session
      .request({
        kind: 'request.decide',
        runId,
        requestId,
        decision: {
          action: 'approve',
          ...(content !== undefined && { content }),
        },
        grant,
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
