/**
 * Host-neutral tool-edit approval state machine.
 *
 * One controller per session owns the requests that session has in flight, so
 * a request can never be settled by another session's controller. Everything
 * a host owns — staging the preview files, opening its diff view, reading back
 * what the user edited — lives behind {@link ToolEditApprovalHost}.
 */

import { nanoid } from 'nanoid';

import type { SessionHostInteractions } from '@agent/runtime/HostInteractions';
import {
  matchesCancelSelector,
  type HostInteractionCancelSelector,
  type HostInteractionOptions,
} from '@agent/runtime/HostInteractions';
import type { SessionHandle } from '@agent/runtime/SessionHandle';
import { isLatexFile } from '@common/files/fileTypeUtils';
import { withEventErrorHandling } from '@controllers/progressView/backend/events/errorHandling';
import type { StreamTabId, ToolEditPermission } from '@shared/schemas';
import type { ToolEditApprovalAction } from '@shared/schemas/prompts';
import {
  previewProposedLatex,
  runLatexdiff,
  type BuildDisplayFn,
  type LatexPreviewEntry,
} from '@tools/approval/latexPreview';
import {
  prepareToolEditApprovalPrompt,
  type ToolEditApprovalRequest,
  type ToolEditApprovalResult,
} from '@tools/approval/toolEditApproval';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { normalizeLineEndings } from '@utils/text/stringUtils';

const CHANNEL = 'ToolEditApproval';

/** The host view of one staged request, live until the approval settles. */
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
  /** True once the approval settled, so hosts can drop late view work. */
  isSettled(): boolean;
  /** Reject the approval because the user closed the host's view. */
  discard(): void;
}

export interface ToolEditApprovalHost {
  /** Materialize the original and proposed content for the host's view. */
  stagePreview(
    request: ToolEditApprovalRequest,
    context: ToolEditPreviewContext,
  ): Promise<ToolEditPreview>;
  /** Path shown to the user, relative to the workspace when there is one. */
  relativeDisplayPath(filePath: string): string;
  /**
   * Resolve once the surface that renders approval prompts is visible.
   * Awaiting it is what keeps a request cancelled while that surface opens
   * from flashing a prompt that is immediately dismissed.
   */
  revealApprovalSurface(): Promise<void>;
  readonly openBuildDisplay: BuildDisplayFn;
  reportError(message: string): void;
}

export interface ToolEditApprovalControllerOptions {
  interactions: Pick<SessionHostInteractions, 'emit'>;
  session: SessionHandle;
  host: ToolEditApprovalHost;
  showToolEditPermission(payload: ToolEditPermission): void;
  resolveToolEditPermission(requestId: string): void;
  /** Cancellation cause reported to the agent when the host detaches. */
  detachCause: string;
}

interface PendingToolEditApproval extends LatexPreviewEntry {
  readonly requestId: string;
  readonly request: ToolEditApprovalRequest;
  readonly relativePath: string;
  readonly preview: ToolEditPreview;
  readonly cancellationScope?: object;
  settle: (result: ToolEditApprovalResult) => void;
}

interface InitializingToolEditApproval {
  readonly request: ToolEditApprovalRequest;
  readonly cancellationScope?: object;
  earlyResolution?: ToolEditApprovalResult;
}

export class ToolEditApprovalController {
  private readonly initializing = new Map<
    string,
    InitializingToolEditApproval
  >();
  private readonly pending = new Map<string, PendingToolEditApproval>();
  private disposed = false;

  constructor(private readonly options: ToolEditApprovalControllerOptions) {}

  async requestApproval(
    request: ToolEditApprovalRequest,
    options?: HostInteractionOptions,
  ): Promise<ToolEditApprovalResult> {
    if (this.disposed) {
      throw new Error('Tool edit approval controller is disposed.');
    }

    const requestId = `approval-${nanoid()}`;
    const relativePath = this.options.host.relativeDisplayPath(request.path);
    const initialization: InitializingToolEditApproval = {
      request,
      cancellationScope: options?.cancellationScope,
    };
    this.initializing.set(requestId, initialization);

    let preview: ToolEditPreview;
    try {
      preview = await this.options.host.stagePreview(request, {
        requestId,
        relativePath,
        isSettled: () => this.isSettled(requestId),
        discard: () => this.discard(requestId),
      });
    } catch (error) {
      this.initializing.delete(requestId);
      throw error;
    }

    if (initialization.earlyResolution) {
      this.initializing.delete(requestId);
      await preview.dispose();
      return initialization.earlyResolution;
    }

    let settled = false;
    const entry: PendingToolEditApproval = {
      requestId,
      request,
      relativePath,
      preview,
      cancellationScope: initialization.cancellationScope,
      originalUri: { fsPath: preview.originalPath },
      proposedUri: { fsPath: preview.proposedPath },
      originalContent: request.originalContent,
      proposedContent: request.proposedContent,
      isSettled: () => settled,
      settle: () => {},
      workspaceTempCleanup: [],
      latexOperationInProgress: false,
      onError: (message) => this.options.host.reportError(message),
    };
    const settlement = new Promise<ToolEditApprovalResult>((resolve) => {
      entry.settle = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
    });
    this.pending.set(requestId, entry);
    this.initializing.delete(requestId);

    try {
      await preview.present();
      if (!settled) {
        void this.runAction(entry, () => this.publishPromptWhenVisible(entry));
      }
      const result = await settlement;

      // `requestToolEditApproval` derives userPatch, lineChanges, and startLine
      // from the content this returns, so an accepted result only owes it the
      // content the user actually approved.
      if (result.accepted && result.appliedContent == null) {
        throw new Error(
          'Tool edit approval settled without the current proposed content.',
        );
      }
      return result;
    } finally {
      this.pending.delete(requestId);
      await preview.dispose();
      await Promise.all(
        entry.workspaceTempCleanup.map((cleanup) =>
          cleanup().catch(() => undefined),
        ),
      );
    }
  }

  handleAction(payload: {
    requestId: string;
    action: ToolEditApprovalAction;
    feedback?: string;
  }): void {
    const entry = this.pending.get(payload.requestId);
    if (!entry || entry.isSettled()) return;

    switch (payload.action) {
      case 'approve':
        void this.runAction(entry, () => this.approve(entry));
        return;
      case 'reject':
        this.settle(payload.requestId, {
          accepted: false,
          userMessage: payload.feedback?.trim() || undefined,
        });
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

  /** Approve requests already awaiting the user on one stream. */
  async approvePendingForStream(streamId: StreamTabId): Promise<void> {
    for (const initialization of this.initializing.values()) {
      if (
        initialization.earlyResolution ||
        initialization.request.streamId !== streamId
      ) {
        continue;
      }
      initialization.earlyResolution = {
        accepted: true,
        appliedContent: initialization.request.proposedContent,
      };
    }

    const entries = [...this.pending.values()].filter(
      (entry) => entry.request.streamId === streamId && !entry.isSettled(),
    );
    await Promise.all(
      entries.map((entry) => this.runAction(entry, () => this.approve(entry))),
    );
  }

  /** Reject the requests this controller owns in the selected scope. */
  cancel(selector: HostInteractionCancelSelector = {}): void {
    for (const initialization of this.initializing.values()) {
      if (
        initialization.earlyResolution ||
        !matchesCancelSelector(
          {
            kind: 'toolEdit',
            streamId: initialization.request.streamId ?? undefined,
            cancellationScope: initialization.cancellationScope,
          },
          selector,
        )
      ) {
        continue;
      }
      initialization.earlyResolution = {
        accepted: false,
        userMessage: selector.cause,
      };
    }

    for (const entry of [...this.pending.values()]) {
      if (
        !matchesCancelSelector(
          {
            kind: 'toolEdit',
            streamId: entry.request.streamId ?? undefined,
            cancellationScope: entry.cancellationScope,
          },
          selector,
        )
      ) {
        continue;
      }
      this.settle(entry.requestId, {
        accepted: false,
        userMessage: selector.cause,
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.cancel({ cause: this.options.detachCause });
  }

  private isSettled(requestId: string): boolean {
    const initialization = this.initializing.get(requestId);
    if (initialization) {
      return initialization.earlyResolution !== undefined;
    }
    return this.pending.get(requestId)?.isSettled() ?? true;
  }

  private discard(requestId: string): void {
    const initialization = this.initializing.get(requestId);
    if (initialization) {
      initialization.earlyResolution ??= { accepted: false };
      return;
    }
    this.settle(requestId, { accepted: false });
  }

  private settle(requestId: string, result: ToolEditApprovalResult): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.isSettled()) return;

    this.pending.delete(requestId);
    entry.settle(result);
    this.resolvePrompt(requestId);
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
    let appliedContent: string;
    try {
      // Normalize: this read bypasses BaseFS so may contain CRLF.
      appliedContent = normalizeLineEndings(
        await entry.preview.readProposedContent(),
      );
    } catch (error) {
      if (entry.isSettled()) return;
      this.options.host.reportError(
        `Approval failed because the edited document could not be read: ${toErrorMessage(error)}`,
      );
      // The frontend removes the panel optimistically on approve. Reset backend
      // delivery tracking, then publish the still-pending request under the
      // same ID so the user can retry instead of the agent hanging.
      this.resolvePrompt(entry.requestId);
      this.publishPrompt(entry);
      return;
    }
    this.settle(entry.requestId, { accepted: true, appliedContent });
  }

  private async publishPromptWhenVisible(
    entry: PendingToolEditApproval,
  ): Promise<void> {
    await this.options.host.revealApprovalSurface();
    if (this.pending.get(entry.requestId) !== entry || entry.isSettled()) {
      return;
    }
    this.publishPrompt(entry);
  }

  private publishPrompt(entry: PendingToolEditApproval): void {
    // Activate the stream that needs approval and post the prompt; each host
    // supplies the display path its own way.
    withEventErrorHandling(CHANNEL, 'failed to show approval prompt', () =>
      this.options.showToolEditPermission(
        prepareToolEditApprovalPrompt(
          this.options.interactions,
          this.options.session,
          {
            requestId: entry.requestId,
            request: entry.request,
            relativePath: entry.relativePath,
          },
        ),
      ),
    );
  }

  private resolvePrompt(requestId: string): void {
    withEventErrorHandling(CHANNEL, 'failed to resolve approval prompt', () =>
      this.options.resolveToolEditPermission(requestId),
    );
  }
}
