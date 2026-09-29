/**
 * Host-neutral tool-edit preview controller.
 *
 * One controller per session stages the previews of that session's tool-edit
 * requests, so a request can never be settled by another session's
 * controller. The request itself is a `request.opened` row the fold lists
 * and a `request.decide` command answers (one run model, 3.7); what lives
 * here is the preview the durable payload cannot carry (the original and
 * proposed content the host shows in its diff view) and the verbs over it.
 * Everything a host owns, staging the preview files, opening its diff view,
 * reading back what the user edited, lives behind {@link ToolEditApprovalHost}.
 *
 * Every verb is an Effect and the controller holds no runtime: a run belongs
 * at a host boundary (the Effect-4 migration's R1, frozen at zero below one
 * by `config/ratchets/effect-migration-baseline.json`) and this controller is
 * host-agnostic, so the host that owns a controller supplies the fiber
 * (`attachSessionHost.ts` is the wiring both hosts share).
 *
 * Two shapes recur. **Admission is synchronous, the work is an Effect**: the
 * bookkeeping — the map write, the `Deferred` a later caller joins — happens
 * in the same step its caller looked the entry up in, so nothing another
 * fiber could interleave with sits between finding an entry and accounting
 * for what is about to happen to it. **Work nobody waits for runs detached**
 * ({@link ToolEditApprovalController.detach}): a fiber of the global scope,
 * so staging and admitted actions finish whether or not the caller that
 * started them is still there, exactly as a voided promise did, and a release
 * joins them through the entry rather than through the fork.
 */

// Third-party imports
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  type FileSystem,
  type Path,
} from 'effect';

// Local imports
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { isLatexFile } from '@common/files/fileTypeUtils';
import { withLogChannel } from '@logger/effectLog';
import {
  Rejected,
  type HostRequestFailure,
} from '@shared/session/requestErrors';
import type { RequestDecision, SessionEvent } from '@shared/schemas';
import type { HostRequest } from '@shared/session/hostRequest';
import {
  previewProposedLatex,
  runLatexdiff,
  type BuildDisplayFn,
  type LatexPreviewEntry,
} from '@tools/approval/latexPreview';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';
import type { ChildProcessSpawner } from 'effect/unstable/process/ChildProcessSpawner';

const CHANNEL = 'ToolEditApproval';

/**
 * Runtime services this controller's programs take: preview programs stage
 * temp files and the host build spawns the compiler. Every method carries
 * them, so a host provides them once, at its run.
 */
type PreviewServices = FileSystem.FileSystem | Path.Path | ChildProcessSpawner;
type PreviewCall<A> = Effect.Effect<A, HostRequestFailure, PreviewServices>;

/** The host view of one staged request, live until the request is decided. */
export interface ToolEditPreview {
  readonly originalPath: string;
  readonly proposedPath: string;
  /**
   * Open the host's diff view for a freshly staged request. A host that
   * publishes its approval prompt independently of the view may return before
   * the view is on screen; a host whose view failure must fail the request
   * fails instead.
   */
  present(): PreviewCall<void>;
  /** Re-open the diff view after the user dismissed it. */
  showDiff(): PreviewCall<void>;
  /** Open the proposed copy in the host's plain file viewer. */
  openProposed(): PreviewCall<void>;
  /** Proposed content including edits the user made in the host's view. */
  readProposedContent(): PreviewCall<string>;
  /** Close the view and remove everything staged for this request. */
  dispose(): PreviewCall<void>;
}

export interface ToolEditPreviewContext {
  readonly requestId: string;
  readonly relativePath: string;
  /** True once the request settled, so hosts can drop late view work. */
  isSettled(): boolean;
}

export interface ToolEditApprovalHost {
  /** Materialize the original and proposed content for the host's view. */
  stagePreview(
    request: ToolEditApprovalRequest,
    context: ToolEditPreviewContext,
  ): PreviewCall<ToolEditPreview>;
  /**
   * The host's build display: the program the LaTeX preview programs yield,
   * forked below so a release still holds a handle on it once a preview
   * program's settle race has interrupted the fiber that started it.
   */
  readonly openBuildDisplay: BuildDisplayFn;
  reportError(message: string): void;
}

interface ToolEditApprovalControllerOptions {
  host: ToolEditApprovalHost;
  /** Where a staged request's decision goes: its `request.decide`. A refusal
   *  (the request already decided, the run gone) comes back typed. */
  session: { readonly requests: Pick<SessionHandle['requests'], 'request'> };
}

/** What both phases of one request name, whichever phase a release finds. */
interface TrackedToolEditApproval {
  /** The full staging/presentation exit, shared by both request phases.
   * Release joins it before cleanup, including when staging is in flight.
   * Carrying Exit prevents a second, unhandled raise of a presentation error. */
  readonly inFlight: Deferred.Deferred<Exit.Exit<void, HostRequestFailure>>;
}

/**
 * A request with no preview: staging is still running, or it failed and none
 * will open. Either way the request is open in the fold with its panel on
 * screen, so a decision on it is answered from the payload it carries.
 */
interface InitializingToolEditApproval extends TrackedToolEditApproval {
  readonly phase: 'initializing';
  readonly request: ToolEditApprovalRequest;
}

/** A staged request awaiting the user. Membership in the map is what "unsettled" means. */
interface PendingToolEditApproval
  extends LatexPreviewEntry, TrackedToolEditApproval {
  readonly phase: 'pending';
  readonly request: ToolEditApprovalRequest;
  readonly preview: ToolEditPreview;
  /**
   * Every action admitted on this entry and every host build one of them
   * started, each as the join that settles when it does.
   * {@link ToolEditApprovalController.release} runs this set before it
   * disposes the preview or removes the temp files the request staged, so no
   * build is left reading files it deletes. It is the one accounting path for
   * both kinds of work, written only by
   * {@link ToolEditApprovalController.track}. A join never fails: an action
   * reports its own failure and a failed build is reported by the program
   * that started it, so this set is ordering, not a second error channel.
   */
  readonly inFlightActions: Set<Effect.Effect<void>>;
}

type ToolEditApprovalState =
  InitializingToolEditApproval | PendingToolEditApproval;

export class ToolEditApprovalController {
  /**
   * Every request this controller stages, in either phase. Membership ends
   * when the request is decided, so no separate settled flag can disagree
   * with the map: a staged request leaves on its `request.decided`, one with
   * no preview the moment its decision is sent, and it comes back if that
   * decision never reached the runtime.
   */
  private readonly requests = new Map<string, ToolEditApprovalState>();
  /**
   * The cleanup in flight for a request whose entry is already gone, until
   * that cleanup settles. {@link startRelease} drops the entry before
   * anything is waited for, so a second release for the same request would
   * otherwise find nothing and settle while the first was still disposing:
   * {@link dispose} admits one release per request before it waits on any,
   * and the host's release for a `request.opened` the runtime refused lands
   * right behind it. Joining what is already running is what makes every
   * release mean the same thing, that nothing is left staged.
   */
  private readonly releasing = new Map<string, Deferred.Deferred<void>>();
  private disposed = false;

  constructor(private readonly options: ToolEditApprovalControllerOptions) {}

  /** Release a staged preview when its request is decided, by any surface. */
  handleSessionEvent(
    event: SessionEvent,
  ): Effect.Effect<void, never, PreviewServices> {
    return Effect.suspend(() =>
      event.type === 'request.decided'
        ? this.detach(this.startRelease(event.requestId))
        : Effect.void,
    );
  }

  /**
   * Stage the preview for a tool-edit request the fold lists (the runtime's
   * `presentToolEdit`). The decision reaches the runtime as a
   * `request.decide` through the session, never through this call.
   */
  present(
    request: ToolEditApprovalRequest,
  ): Effect.Effect<void, HostRequestFailure, PreviewServices> {
    return Effect.suspend(() => {
      if (this.disposed) {
        return Effect.fail(
          new Rejected({
            reason: 'Tool edit approval controller is disposed.',
          }),
        );
      }

      // The request id the tool boundary minted for the `request.opened`
      // fact is the one every surface shows and answers.
      const { requestId } = request.permission;
      // Filled by the staging below and published here, before the entry
      // that names it: a release finds either no entry at all or an entry
      // with the staging's outcome to wait for, never one with neither.
      const inFlight =
        Deferred.makeUnsafe<Exit.Exit<void, HostRequestFailure>>();
      const initialization: InitializingToolEditApproval = {
        phase: 'initializing',
        request,
        inFlight,
      };
      this.requests.set(requestId, initialization);

      // Detached, because a staging failure leaves the entry in place — the
      // request is still open in the fold with its panel on screen, and an
      // approve on it decides from the payload — and because the
      // staging has to finish whatever became of the caller waiting below.
      // The failure itself is re-raised here, which is where each host
      // reports it.
      return Effect.forkDetach(
        this.stage(request, initialization).pipe(
          Effect.onExit((exit) => Deferred.succeed(inFlight, exit)),
        ),
      ).pipe(
        Effect.andThen(Deferred.await(inFlight)),
        Effect.flatMap((exit): Effect.Effect<void, HostRequestFailure> => exit),
      );
    });
  }

  handleAction(
    payload: Pick<
      Extract<HostRequest, { kind: 'toolEdit' }>,
      'requestId' | 'action'
    >,
  ): Effect.Effect<void, never, PreviewServices> {
    const { requestId, action } = payload;
    if (action === 'approve') {
      return this.approveStaged(requestId).pipe(Effect.asVoid);
    }
    return Effect.suspend(() => {
      const entry = this.requests.get(requestId);
      if (entry?.phase !== 'pending') return Effect.void;

      switch (action) {
        case 'openDiff':
          return this.detach(this.admit(entry, () => entry.preview.showDiff()));
        case 'previewProposed':
          return this.detach(
            this.admit(entry, () => this.previewProposed(entry)),
          );
        case 'showLatexdiff':
          // ONLYCHANGEDPAGE keeps a tool-edit diff focused on the changes.
          return this.detach(
            this.admit(entry, () =>
              runLatexdiff(entry, {
                subtype: 'ONLYCHANGEDPAGE',
                openBuildDisplay: this.buildDisplayFor(entry),
              }),
            ),
          );
      }
      action satisfies never;
      return Effect.void;
    });
  }

  /**
   * Approve one staged request as its Approve button does: the edited
   * document read back from the view, or the proposal when there is none.
   * `false` when nothing is staged, which the caller answers itself.
   */
  approveStaged(
    requestId: string,
  ): Effect.Effect<boolean, never, PreviewServices> {
    return Effect.suspend(() => {
      const entry = this.requests.get(requestId);
      if (!entry) return Effect.succeed(false);
      return this.detach(
        entry.phase === 'initializing'
          ? this.decideFromPayload(entry, {
              action: 'approve',
              content: entry.request.proposedContent,
            })
          : this.admit(entry, () => this.approve(entry)),
      ).pipe(Effect.as(true));
    });
  }

  /** Drop every staged preview and settle once all are gone; the runs that
   *  opened the requests close them. */
  dispose(): Effect.Effect<void, never, PreviewServices> {
    return Effect.suspend(() => {
      if (this.disposed) return Effect.void;
      this.disposed = true;
      // Every release is admitted here, in one step, before any of them
      // runs: a release taken right behind this one finds each request's
      // cleanup already published and joins it rather than starting a second.
      const cleanups = [...this.requests.keys()].map((requestId) =>
        this.startRelease(requestId),
      );
      return Effect.all(cleanups, { concurrency: 'unbounded', discard: true });
    });
  }

  /**
   * Drop the preview staged for one request, and settle once it is gone.
   * `request.decided` is how a decided request releases; a host runs this for
   * a request whose `request.opened` was refused, which no decision follows.
   * A {@link present} call still in flight is the reason that wait has to
   * reach inside it: dropping the entry alone would settle while the host was
   * still writing temp files it would then delete on its own time, or still
   * opening a diff view onto files this call is about to delete. Repeated
   * releases for one request, which {@link dispose} and that host call
   * produce together, all settle on the one cleanup in flight.
   */
  release(requestId: string): Effect.Effect<void, never, PreviewServices> {
    return Effect.suspend(() => this.startRelease(requestId));
  }

  /**
   * Stage one request on the host and open its view: the operation both
   * phases of the entry name. Staging, promotion and presentation are one
   * operation, so a release observes only its two ends: it lands before the
   * settled check below, where this call disposes the preview it staged and
   * never opens a view on it, or after the entry is staged, where the release
   * waits for the view to be open before closing it and deleting what it
   * reads.
   */
  private stage(
    request: ToolEditApprovalRequest,
    initialization: InitializingToolEditApproval,
  ): Effect.Effect<void, HostRequestFailure, PreviewServices> {
    const { requestId, relativePath } = request.permission;
    return this.options.host
      .stagePreview(request, {
        requestId,
        relativePath,
        isSettled: () => !this.requests.has(requestId),
      })
      .pipe(
        Effect.flatMap((preview) => {
          // The entry this call installed is gone when the request was
          // decided, released, or the controller disposed while the host was
          // staging: an entry with no preview holds nothing to release, so
          // the preview that just finished staging is this call's to clean
          // up. Promoting it would open a diff view for a settled request and
          // leave the staged files behind. That disposal is inside the
          // operation the entry named, which is how a release taken while
          // this was in flight waited for it.
          if (this.requests.get(requestId) !== initialization) {
            return preview.dispose();
          }

          const staged: PendingToolEditApproval = {
            phase: 'pending',
            request,
            preview,
            originalUri: { fsPath: preview.originalPath },
            proposedUri: { fsPath: preview.proposedPath },
            originalContent: request.originalContent,
            proposedContent: request.proposedContent,
            isSettled: () => this.requests.get(requestId) !== staged,
            // Filled by the release that drops the entry, which is what
            // interrupts a LaTeX preview still running on it.
            settled: Deferred.makeUnsafe<void>(),
            workspaceTempCleanup: [],
            latexOperationInProgress: false,
            onError: (message) => this.options.host.reportError(message),
            inFlightActions: new Set(),
            // This operation's outcome: the staged entry names the one the
            // initializing entry named, so a release finds it in either phase.
            inFlight: initialization.inFlight,
          };
          this.requests.set(requestId, staged);

          return staged.preview.present();
        }),
      );
  }

  /**
   * Decide a request that has no preview: the entry goes now, in this
   * synchronous step, because there is nothing to hold until the fold
   * answers, a second action while the decision is in flight has nothing to
   * act on, and a preview still staging is disposed by the {@link present}
   * call that finishes it.
   *
   * A decision the runtime never accepted puts an entry back, because the
   * request is still open in the fold with its panel on screen and the user's
   * next Approve or Reject has to find something to act on. It is a fresh
   * entry, not the one {@link present} installed: a staging call still in
   * flight must still find its own gone and dispose the preview it staged,
   * rather than open a diff view on the strength of a failed decision. It
   * names that same operation, so a release on the replacement waits for the
   * disposal the original will do.
   */
  private decideFromPayload(
    entry: InitializingToolEditApproval,
    decision: RequestDecision,
  ): Effect.Effect<void, never, PreviewServices> {
    const { request } = entry;
    const { requestId } = request.permission;
    this.requests.delete(requestId);
    return this.send(request, decision).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.sync(() => {
              if (!this.disposed && !this.requests.has(requestId)) {
                this.requests.set(requestId, {
                  phase: 'initializing',
                  request,
                  inFlight: entry.inFlight,
                });
              }
              this.options.host.reportError(
                toErrorMessage(Cause.squash(cause)),
              );
            }),
      ),
    );
  }

  /** Send one decision; `request.decided` then releases the preview. */
  private send(
    request: ToolEditApprovalRequest,
    decision: RequestDecision,
  ): Effect.Effect<void, HostRequestFailure> {
    return Effect.suspend(() => {
      const runId = request.runId;
      if (!runId) {
        return Effect.die(
          new Error(
            `Tool edit request ${request.permission.requestId} names no run to decide on.`,
          ),
        );
      }
      return this.options.session.requests
        .request({
          kind: 'request.decide',
          runId,
          requestId: request.permission.requestId,
          decision,
        })
        .pipe(Effect.asVoid);
    });
  }

  /**
   * Admit one release: drop the entry, stop a preview program still running
   * on it, and publish the cleanup every later release for the request joins
   * — all synchronously, in the step its caller looked the entry up in, so
   * two releases can never both start one. Returns the cleanup left to run,
   * or the join for the one already running.
   */
  private startRelease(
    requestId: string,
  ): Effect.Effect<void, never, PreviewServices> {
    // A release already in flight for this request is doing exactly this
    // work, on the entry it has already dropped: join it, rather than read
    // an empty map and report the preview gone while it is still going.
    const joined = this.releasing.get(requestId);
    if (joined) return Deferred.await(joined);

    const entry = this.requests.get(requestId);
    if (!entry) return Effect.void;
    this.requests.delete(requestId);
    // A LaTeX preview still running on the entry stops here, subprocess and
    // all, rather than finishing for a request nobody is looking at.
    if (entry.phase === 'pending') {
      Deferred.doneUnsafe(entry.settled, Effect.void);
    }

    // The whole cleanup is published here, before its first wait, and
    // withdrawn once it settles, so every release taken meanwhile settles
    // with it and none settles before it.
    const done = Deferred.makeUnsafe<void>();
    this.releasing.set(requestId, done);
    return this.cleanup(requestId, entry).pipe(
      Effect.onExit((exit) =>
        Effect.sync(() => {
          this.releasing.delete(requestId);
          Deferred.doneUnsafe(done, exit);
        }),
      ),
    );
  }

  /**
   * Everything one release waits for, in the order it has to wait in.
   * Removing the entry is what tells a `present` call still in flight that
   * its request is settled; waiting for that call is what makes a settled
   * release mean nothing is left staged and nothing is still opening. It
   * covers the staging of a preview this call never sees (that call disposes
   * it), and the view a just-staged request is in the middle of opening,
   * which has to be open before it can be closed below.
   */
  private cleanup(
    requestId: string,
    entry: ToolEditApprovalState,
  ): Effect.Effect<void, never, PreviewServices> {
    const { host } = this.options;
    return Effect.gen(function* () {
      const staging = yield* Deferred.await(entry.inFlight);
      if (Exit.isFailure(staging)) {
        yield* Effect.logWarning(
          `The tool-edit preview for request ${requestId} failed while its release waited for it`,
        ).pipe(
          Effect.annotateLogs({ data: Cause.squash(staging.cause) }),
          withLogChannel(CHANNEL),
        );
      }
      if (entry.phase !== 'pending') return;

      // An action, or a build one of them started, may still be running:
      // settling above stopped the preview program, not the host's build,
      // which has no cancellation signal. Joining them here is what keeps this
      // release from deleting the diff files under a build still reading them.
      // Nothing is admitted after the entry delete above, so this snapshot is
      // complete.
      yield* Effect.forEach([...entry.inFlightActions], (join) => join, {
        concurrency: 'unbounded',
        discard: true,
      });
      // closeDiff can reject at window teardown; the latexdiff files must still go.
      yield* entry.preview.dispose().pipe(
        Effect.ensuring(
          Effect.suspend(() =>
            Effect.forEach(
              entry.workspaceTempCleanup,
              (removeTemp) => removeTemp,
              { concurrency: 'unbounded', discard: true },
            ),
          ),
        ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => {
                host.reportError(toErrorMessage(Cause.squash(cause)));
              }),
        ),
      );
    });
  }

  /**
   * Admit one action on an entry: the join a release waits on is registered
   * synchronously and withdrawn once the action settles. The action is a
   * thunk, so a host method runs when the action does, not when admitted. A
   * failure is reported only while the request is unsettled: after that no
   * user is left to tell.
   */
  private admit(
    entry: PendingToolEditApproval,
    action: () => Effect.Effect<void, HostRequestFailure, PreviewServices>,
  ): Effect.Effect<void, never, PreviewServices> {
    const withdraw = this.track(entry);
    return Effect.suspend(action).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.sync(() => {
              if (!entry.isSettled()) {
                this.options.host.reportError(
                  toErrorMessage(Cause.squash(cause)),
                );
              }
            }),
      ),
      // Withdrawn on any exit, so a release is never left waiting on a join.
      Effect.onExit(() => withdraw),
    );
  }

  /**
   * Register one join on an entry, synchronously in the step its caller
   * found the entry in, and hand back its withdrawal. A join never fails —
   * the work behind it reports its own failure — so {@link cleanup} waits on
   * ordering, not on a second error channel.
   */
  private track(entry: PendingToolEditApproval): Effect.Effect<void> {
    const settled = Deferred.makeUnsafe<void>();
    const join = Deferred.await(settled);
    entry.inFlightActions.add(join);
    return Effect.sync(() => {
      entry.inFlightActions.delete(join);
      Deferred.doneUnsafe(settled, Effect.void);
    });
  }

  /** Start one admitted program on a fiber that outlives this call; a
   *  release joins it through the entry, never through this fork. */
  private detach(
    program: Effect.Effect<void, never, PreviewServices>,
  ): Effect.Effect<void, never, PreviewServices> {
    return Effect.forkDetach(program).pipe(Effect.asVoid);
  }

  /**
   * The display program the preview programs get for one entry. It starts no
   * build for a settled request, and runs the host's build on a fiber of its
   * own: the settle race interrupts the fiber that yielded this one, which
   * must not take the build down, and {@link release} joins it so the build
   * is not still reading the temp files it deletes.
   */
  private buildDisplayFor(entry: PendingToolEditApproval): BuildDisplayFn {
    return (location, options) =>
      Effect.suspend(() => {
        // A settle can land between the program's own check and this one.
        if (entry.isSettled()) return Effect.void;

        // Withdrawn from the build's own exit, not the caller's: an
        // interrupted caller leaves the build running, which a release
        // still has to wait for.
        const withdraw = this.track(entry);
        return Effect.forkDetach(
          this.options.host
            .openBuildDisplay(location, options)
            .pipe(Effect.onExit(() => withdraw)),
        ).pipe(Effect.flatMap(Fiber.join));
      });
  }

  private previewProposed(
    entry: PendingToolEditApproval,
  ): Effect.Effect<void, HostRequestFailure, PreviewServices> {
    return Effect.suspend(() =>
      isLatexFile(entry.request.path)
        ? previewProposedLatex(entry, {
            openBuildDisplay: this.buildDisplayFor(entry),
          })
        : entry.preview.openProposed(),
    );
  }

  private approve(
    entry: PendingToolEditApproval,
  ): Effect.Effect<void, HostRequestFailure, PreviewServices> {
    return entry.preview.readProposedContent().pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.sync(() => {
                if (entry.isSettled()) return;
                this.options.host.reportError(
                  `Approval failed because the edited document could not be read: ${toErrorMessage(Cause.squash(cause))}`,
                );
              }),
        onSuccess: (content) =>
          this.send(entry.request, {
            action: 'approve',
            // Normalize: the host read these bytes itself, so they may be CRLF.
            content: normalizeLineEndings(content),
          }),
      }),
    );
  }
}
