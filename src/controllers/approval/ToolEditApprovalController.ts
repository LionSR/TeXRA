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
 */

// Local imports
import { isLatexFile } from '@common/files/fileTypeUtils';
import { createLog } from '@logger/logUtils';
import type {
  RequestDecision,
  SessionEvent,
  RunId,
  ToolEditApprovalAction,
} from '@shared/schemas';
import {
  previewProposedLatex,
  runLatexdiff,
  type BuildDisplayFn,
  type LatexPreviewEntry,
} from '@tools/approval/latexPreview';
import type { ToolEditApprovalRequest } from '@tools/approval/toolEditApproval';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const log = createLog('ToolEditApproval');

/** The host view of one staged request, live until the request is decided. */
export interface ToolEditPreview {
  readonly originalPath: string;
  readonly proposedPath: string;
  /**
   * Open the host's diff view for a freshly staged request. A host that
   * publishes its approval prompt independently of the view may return before
   * the view is on screen; a host whose view failure must fail the request
   * rejects instead.
   */
  present(): Promise<void>;
  /** Re-open the diff view after the user dismissed it. */
  showDiff(): Promise<void>;
  /** Open the proposed copy in the host's plain file viewer. */
  openProposed(): Promise<void>;
  /** Proposed content including edits the user made in the host's view. */
  readProposedContent(): Promise<string>;
  /** Close the view and remove everything staged for this request. */
  dispose(): Promise<void>;
}

export interface ToolEditPreviewContext {
  readonly requestId: string;
  readonly relativePath: string;
  /** True once the request settled, so hosts can drop late view work. */
  isSettled(): boolean;
  /** Reject the request because the user closed the host's view. */
  discard(): void;
}

export interface ToolEditApprovalHost {
  /** Materialize the original and proposed content for the host's view. */
  stagePreview(
    request: ToolEditApprovalRequest,
    context: ToolEditPreviewContext,
  ): Promise<ToolEditPreview>;
  /** Reopen the host surface containing the pending request's controls. */
  revealApprovalSurface(): Promise<void>;
  readonly openBuildDisplay: BuildDisplayFn;
  reportError(message: string): void;
  /**
   * Send the decision for a staged request: the host's `request.decide` on
   * its session. Resolves once the runtime answered; a refusal (the request
   * already decided, the run gone) is the host's to word.
   */
  decide(
    runId: RunId,
    requestId: string,
    decision: RequestDecision,
  ): Promise<void>;
}

interface ToolEditApprovalControllerOptions {
  host: ToolEditApprovalHost;
}

/**
 * A request with no preview: staging is still running, or it failed and none
 * will open. Either way the request is open in the fold with its panel on
 * screen, so a decision on it is answered from the payload it carries.
 */
interface InitializingToolEditApproval {
  readonly phase: 'initializing';
  readonly request: ToolEditApprovalRequest;
  /**
   * The staging in flight for this request, or an already-resolved promise
   * when none is: everything {@link ToolEditApprovalController.present} is
   * awaiting, from `stagePreview` through either the promotion to a staged
   * entry or the disposal of a preview whose entry was gone by the time it
   * finished. {@link ToolEditApprovalController.release} awaits it, so a
   * release that lands mid-staging still returns with nothing left staged.
   *
   * It resolves to whatever ended the staging in failure, or `undefined`,
   * rather than rejecting: `present` propagates that failure to its own
   * caller, and a rejection here would be a second one with nobody left to
   * handle it.
   */
  staging: Promise<unknown>;
}

/** A staged request awaiting the user. Membership in the map is what "unsettled" means. */
interface PendingToolEditApproval extends LatexPreviewEntry {
  readonly phase: 'pending';
  readonly requestId: string;
  readonly request: ToolEditApprovalRequest;
  readonly relativePath: string;
  readonly preview: ToolEditPreview;
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
  private disposed = false;

  constructor(private readonly options: ToolEditApprovalControllerOptions) {}

  /** Release a staged preview when its request is decided, by any surface. */
  handleSessionEvent(event: SessionEvent): void {
    if (event.type !== 'request.decided') return;
    void this.release(event.requestId);
  }

  /**
   * Stage the preview for a tool-edit request the fold lists (the runtime's
   * `presentToolEdit`). The decision reaches the runtime through
   * {@link ToolEditApprovalHost.decide}, never through this call.
   */
  async present(request: ToolEditApprovalRequest): Promise<void> {
    if (this.disposed) {
      throw new Error('Tool edit approval controller is disposed.');
    }

    // The request id the tool boundary minted for the `request.opened`
    // fact is the one every surface shows and answers.
    const { requestId, relativePath } = request.permission;
    const initialization: InitializingToolEditApproval = {
      phase: 'initializing',
      request,
      // Replaced below by the staging this call is about to start, before
      // any await can let a release read the entry.
      staging: Promise.resolve(undefined),
    };
    this.requests.set(requestId, initialization);

    // A staging failure leaves the entry in place: the request is still open
    // in the fold with its panel on screen, and an approve or reject on it
    // decides from the payload. The failure itself propagates to the caller,
    // which is where each host reports it.
    const staging = (async (): Promise<PendingToolEditApproval | undefined> => {
      const preview = await this.options.host.stagePreview(request, {
        requestId,
        relativePath,
        isSettled: () => this.isSettled(requestId),
        discard: () => this.discard(requestId),
      });

      // The entry this call installed is gone when the request was decided or
      // the controller disposed while the host was staging: an entry with no
      // preview holds nothing to release, so the preview that just finished
      // staging is this call's to clean up. Promoting it would open a diff
      // view for a settled request and leave the staged files behind. That
      // disposal is inside the staging the entry named, which is how a
      // release taken while this was in flight waited for it.
      if (this.requests.get(requestId) !== initialization) {
        await preview.dispose();
        return undefined;
      }

      const staged: PendingToolEditApproval = {
        phase: 'pending',
        requestId,
        request,
        relativePath,
        preview,
        originalUri: { fsPath: preview.originalPath },
        proposedUri: { fsPath: preview.proposedPath },
        originalContent: request.originalContent,
        proposedContent: request.proposedContent,
        isSettled: () => this.requests.get(requestId) !== staged,
        workspaceTempCleanup: [],
        latexOperationInProgress: false,
        onError: (message) => this.options.host.reportError(message),
      };
      this.requests.set(requestId, staged);
      return staged;
    })();
    initialization.staging = staging.then(
      () => undefined,
      (error: unknown) => error,
    );

    const entry = await staging;
    // Staging finished onto an entry that is no longer this call's: it
    // disposed what it staged, and there is nothing to show.
    if (!entry) return;

    await entry.preview.present();
    if (!entry.isSettled()) {
      void this.runAction(entry, () =>
        this.options.host.revealApprovalSurface(),
      );
    }
  }

  handleAction(payload: {
    requestId: string;
    action: ToolEditApprovalAction;
    feedback?: string;
  }): void {
    const entry = this.requests.get(payload.requestId);
    if (!entry) return;
    if (entry.phase === 'initializing') {
      // No preview to read the edited file back from or to open, so the
      // proposal the request carries is the whole answer.
      if (payload.action === 'approve') {
        this.decideFromPayload(entry, {
          action: 'approve',
          content: entry.request.proposedContent,
        });
      } else if (payload.action === 'reject') {
        this.decideFromPayload(entry, {
          action: 'reject',
          feedback: payload.feedback?.trim() || null,
        });
      }
      return;
    }

    switch (payload.action) {
      case 'approve':
        void this.runAction(entry, () => this.approve(entry));
        return;
      case 'reject':
        void this.runAction(entry, () =>
          this.send(entry.request, {
            action: 'reject',
            feedback: payload.feedback?.trim() || null,
          }),
        );
        return;
      case 'openDiff':
        void this.runAction(entry, () => entry.preview.showDiff());
        return;
      case 'previewProposed':
        void this.runAction(entry, () => this.previewProposed(entry));
        return;
      case 'showLatexdiff':
        // ONLYCHANGEDPAGE keeps a tool-edit diff focused on the changes.
        void this.runAction(entry, () =>
          runLatexdiff(entry, {
            subtype: 'ONLYCHANGEDPAGE',
            openBuildDisplay: this.options.host.openBuildDisplay,
          }),
        );
        return;
    }
    payload.action satisfies never;
  }

  /** Approve requests already awaiting the user on one run. */
  async approvePendingForRun(runId: RunId): Promise<void> {
    const staged: PendingToolEditApproval[] = [];
    for (const state of this.requests.values()) {
      if (state.request.runId !== runId) continue;
      if (state.phase === 'initializing') {
        this.decideFromPayload(state, {
          action: 'approve',
          content: state.request.proposedContent,
        });
        continue;
      }
      staged.push(state);
    }
    await Promise.all(
      staged.map((entry) => this.runAction(entry, () => this.approve(entry))),
    );
  }

  /** Drop every staged preview. The requests stay pending in the fold: the
   *  runs that opened them close them with the fibers waiting on them. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const requestId of [...this.requests.keys()])
      void this.release(requestId);
  }

  private isSettled(requestId: string): boolean {
    return !this.requests.has(requestId);
  }

  private discard(requestId: string): void {
    const state = this.requests.get(requestId);
    if (state?.phase === 'initializing') {
      this.decideFromPayload(state, { action: 'reject' });
      return;
    }
    if (state?.phase === 'pending') {
      void this.runAction(state, () =>
        this.send(state.request, { action: 'reject' }),
      );
    }
  }

  /**
   * Decide a request that has no preview: the entry goes now, because there
   * is nothing to hold until the fold answers, a second action while the
   * decision is in flight has nothing to act on, and a preview still staging
   * is disposed by the {@link present} call that finishes it.
   *
   * A decision the runtime never accepted puts an entry back, because the
   * request is still open in the fold with its panel on screen and the user's
   * next Approve or Reject has to find something to act on. It is a fresh
   * entry, not the one {@link present} installed: a staging call still in
   * flight must still find its own gone and dispose the preview it staged,
   * rather than open a diff view on the strength of a failed decision. It
   * names that same staging, so a release on the replacement waits for the
   * disposal the original will do.
   */
  private decideFromPayload(
    entry: InitializingToolEditApproval,
    decision: RequestDecision,
  ): void {
    const { request } = entry;
    const { requestId } = request.permission;
    this.requests.delete(requestId);
    void this.send(request, decision).then(undefined, (error: unknown) => {
      if (!this.disposed && !this.requests.has(requestId)) {
        this.requests.set(requestId, {
          phase: 'initializing',
          request,
          staging: entry.staging,
        });
      }
      this.options.host.reportError(toErrorMessage(error));
    });
  }

  /** Send one decision for a staged request; the fold's `request.decided`
   *  then releases the preview through {@link handleSessionEvent}. */
  private async send(
    request: ToolEditApprovalRequest,
    decision: RequestDecision,
  ): Promise<void> {
    const runId = request.runId;
    if (!runId) {
      throw new Error(
        `Tool edit request ${request.permission.requestId} names no run to decide on.`,
      );
    }
    await this.options.host.decide(
      runId,
      request.permission.requestId,
      decision,
    );
  }

  /**
   * Drop the preview staged for one request, and resolve once it is gone.
   * The `request.decided` route above is how a decided request releases; a
   * host calls this directly for a request whose `request.opened` was
   * refused, which no decision follows, and awaits it before reporting the
   * refusal. A request still staging is the reason that await has to reach
   * inside {@link present}: dropping the entry alone would return while the
   * host was still writing temp files it would then delete on its own time.
   */
  async release(requestId: string): Promise<void> {
    const entry = this.requests.get(requestId);
    if (!entry) return;
    this.requests.delete(requestId);
    if (entry.phase === 'initializing') {
      // Nothing is staged yet, but something may be staging: the entry this
      // call just removed is what tells that staging to dispose the preview
      // it is about to receive, so waiting for it here is what makes a
      // returned release mean the preview is gone, in flight or not.
      const failure = await entry.staging;
      if (failure !== undefined) {
        log.warn(
          `The tool-edit preview staging for request ${requestId} failed while its release waited for it`,
          { data: failure },
        );
      }
      return;
    }
    try {
      await entry.preview.dispose();
      await Promise.all(entry.workspaceTempCleanup.map((cleanup) => cleanup()));
    } catch (error) {
      this.options.host.reportError(toErrorMessage(error));
    }
  }

  private async runAction(
    entry: PendingToolEditApproval,
    action: () => Promise<void>,
  ): Promise<void> {
    try {
      await action();
    } catch (error) {
      if (!entry.isSettled()) {
        this.options.host.reportError(toErrorMessage(error));
      }
    }
  }

  private async previewProposed(entry: PendingToolEditApproval): Promise<void> {
    if (isLatexFile(entry.request.path)) {
      await previewProposedLatex(entry, {
        openBuildDisplay: this.options.host.openBuildDisplay,
      });
      return;
    }
    await entry.preview.openProposed();
  }

  private async approve(entry: PendingToolEditApproval): Promise<void> {
    let content: string;
    try {
      // Normalize: this read bypasses BaseFS so may contain CRLF.
      content = normalizeLineEndings(await entry.preview.readProposedContent());
    } catch (error) {
      if (entry.isSettled()) return;
      this.options.host.reportError(
        `Approval failed because the edited document could not be read: ${toErrorMessage(error)}`,
      );
      return;
    }
    await this.send(entry.request, { action: 'approve', content });
  }
}
