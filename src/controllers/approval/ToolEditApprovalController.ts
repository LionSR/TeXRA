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
 * host-agnostic, so the two host wiring points that own a controller
 * (`desktopAgentRun.ts`, `ProgressViewProvider.ts`) supply the fiber.
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
import { isLatexFile } from '@common/files/fileTypeUtils';
import { withLogChannel } from '@logger/effectLog';
import {
  Rejected,
  type HostRequestFailure,
} from '@shared/session/requestErrors';
import type { RequestDecision, SessionEvent, RunId } from '@shared/schemas';
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

const CHANNEL = 'ToolEditApproval';

/**
 * The services the programs this controller composes take from the runtime a
 * host runs them on: the LaTeX preview programs read and write the temp files
 * they stage, and the host build they call compiles against the session's
 * roots. Every method here carries them, so a host provides them once, at its
 * run.
 */
type PreviewServices = FileSystem.FileSystem | Path.Path;

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
  present(): Effect.Effect<void, HostRequestFailure>;
  /** Re-open the diff view after the user dismissed it. */
  showDiff(): Effect.Effect<void, HostRequestFailure>;
  /** Open the proposed copy in the host's plain file viewer. */
  openProposed(): Effect.Effect<void, HostRequestFailure>;
  /** Proposed content including edits the user made in the host's view. */
  readProposedContent(): Effect.Effect<string, HostRequestFailure>;
  /** Close the view and remove everything staged for this request. */
  dispose(): Effect.Effect<void, HostRequestFailure>;
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
  ): Effect.Effect<ToolEditPreview, HostRequestFailure>;
  /**
   * Reopen the host surface containing the pending request's controls, for a
   * host that has one to reopen: the VS Code progress view is a panel the
   * user can have closed, while the desktop prompt shows in whichever view is
   * open. Optional rather than a no-op on the hosts that reveal nothing,
   * which is what the rest of this repo's host ports do (`HostInteractions`).
   */
  revealApprovalSurface?(): Effect.Effect<void, HostRequestFailure>;
  /**
   * The host's build display: the program the LaTeX preview programs yield,
   * forked below so a release still holds a handle on it once a preview
   * program's settle race has interrupted the fiber that started it.
   */
  readonly openBuildDisplay: BuildDisplayFn;
  reportError(message: string): void;
  /**
   * Send the decision for a staged request: the host's `request.decide` on
   * its session. Settles once the runtime answered; a refusal (the request
   * already decided, the run gone) is the host's to word.
   */
  decide(
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
  ): Effect.Effect<void, HostRequestFailure>;
}

interface ToolEditApprovalControllerOptions {
  host: ToolEditApprovalHost;
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
   * `presentToolEdit`). The decision reaches the runtime through
   * {@link ToolEditApprovalHost.decide}, never through this call.
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
      // approve or reject on it decides from the payload — and because the
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

  handleAction(payload: {
    requestId: string;
    action: Extract<HostRequest, { kind: 'toolEdit' }>['action'];
    feedback?: string;
  }): Effect.Effect<void, never, PreviewServices> {
    return Effect.suspend(() => {
      const entry = this.requests.get(payload.requestId);
      if (!entry) return Effect.void;
      if (entry.phase === 'initializing') {
        // No preview to read the edited file back from or to open, so the
        // proposal the request carries is the whole answer.
        if (payload.action === 'approve') {
          return this.detach(
            this.decideFromPayload(entry, {
              action: 'approve',
              content: entry.request.proposedContent,
            }),
          );
        }
        if (payload.action === 'reject') {
          return this.detach(
            this.decideFromPayload(entry, {
              action: 'reject',
              feedback: payload.feedback?.trim() || null,
            }),
          );
        }
        return Effect.void;
      }

      switch (payload.action) {
        case 'approve':
          return this.detach(this.admit(entry, () => this.approve(entry)));
        case 'reject':
          return this.detach(
            this.admit(entry, () =>
              this.send(entry.request, {
                action: 'reject',
                feedback: payload.feedback?.trim() || null,
              }),
            ),
          );
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
      payload.action satisfies never;
      return Effect.void;
    });
  }

  /** Drop every staged preview and settle once all are gone; the runs that
   *  opened the requests, still pending in the fold, close them. */
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
   * The `request.decided` route above is how a decided request releases; a
   * host runs this directly for a request whose `request.opened` was refused,
   * which no decision follows, and waits for it before reporting the refusal.
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
        isSettled: () => this.isSettled(requestId),
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

          return staged.preview.present().pipe(
            Effect.andThen(
              Effect.suspend(() =>
                staged.isSettled()
                  ? Effect.void
                  : this.detach(
                      // Admitted whether or not this host reveals
                      // anything, so a release landing in that window joins
                      // it either way.
                      this.admit(
                        staged,
                        () =>
                          this.options.host.revealApprovalSurface?.() ??
                          Effect.void,
                      ),
                    ),
              ),
            ),
          );
        }),
      );
  }

  private isSettled(requestId: string): boolean {
    return !this.requests.has(requestId);
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

  /** Send one decision for a staged request; the fold's `request.decided`
   *  then releases the preview through {@link handleSessionEvent}. */
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
      return this.options.host.decide(
        runId,
        request.permission.requestId,
        decision,
      );
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
      yield* entry.preview.dispose().pipe(
        Effect.andThen(
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
   * here, synchronously, in the step its caller found the entry in, and
   * withdrawn once the action settles. The action itself is a thunk, so a
   * host method behind it is invoked when the action runs rather than when it
   * is admitted. A failure is reported only while the request is unsettled:
   * an action that fails after the entry is gone has no user left to tell.
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
      // Withdrawn from this action's own exit, whichever it is, so a release
      // can never be left waiting on a join nothing will fill.
      Effect.onExit(() => withdraw),
    );
  }

  /**
   * Register one join on an entry and hand back its withdrawal: registered
   * synchronously, in the step its caller found the entry in, and withdrawn
   * by whichever exit that caller decides owns it. A join never fails — the
   * work behind it reports its own failure — so {@link cleanup} waits on
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

  /**
   * Start one admitted program on a fiber of its own that outlives this call,
   * which is what voiding its promise used to mean: nothing here waits for
   * it, and a release joins it through the entry, never through this fork.
   */
  private detach(
    program: Effect.Effect<void, never, PreviewServices>,
  ): Effect.Effect<void, never, PreviewServices> {
    return Effect.forkDetach(program).pipe(Effect.asVoid);
  }

  /**
   * The display program the preview programs get for one entry. It refuses to
   * start a build for a request that already settled, and it runs the host's
   * build on a fiber of its own: the program's settle race interrupts the
   * fiber that yielded this one, which must not take the build down with it,
   * and the join registered here is what {@link release} waits on so the
   * build is not still reading the temp files it deletes.
   */
  private buildDisplayFor(entry: PendingToolEditApproval): BuildDisplayFn {
    return (location, options) =>
      Effect.suspend(() => {
        // The program's own settled check and this call are separate steps, so
        // a settle can land between them: refuse to start work for a request
        // nobody is looking at.
        if (entry.isSettled()) return Effect.void;

        // Registered before the fork, in this same step, and withdrawn from
        // the build's own exit rather than from the caller's: an interrupted
        // caller leaves the build running, which is exactly what a release
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
