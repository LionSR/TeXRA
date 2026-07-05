/** Base class for request panels that support rejection feedback. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Side-effect imports - register WA textarea + the approve-split component
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import './ApproveSplitButton';

// Local imports - shared utilities
import {
  FEEDBACK_ELIGIBLE_KINDS,
  PERMISSION_KIND,
} from '@shared/utils/uiConstants';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Local imports - progress view events
import { APPROVE_SESSION_ACTION } from '../events';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - progress view component types
import type { PermissionState } from '../permissionState';

/**
 * `allowBypass` / `streamId` are structurally present on every permission
 * kind whose schema extends `PermissionBaseSchema` (toolEdit, bash,
 * externalInquiry, userQuestion) — see `src/shared/schemas/prompts.ts`. The
 * remaining kinds (retry, proposal, planApproval) don't carry them at all.
 * `BaseFeedbackPanel` is the shared base for every feedback-eligible panel
 * (all of the above except retry), so it can't be generically constrained to
 * "just the kinds with these fields" — `PlanApprovalRequestPanel` inherits
 * `canBypass` without overriding it. An exhaustive switch here (rather than a
 * cast on `this.permission.data`) keeps the "which kinds have this" list
 * type-checked against the real union instead of hand-rolled.
 */
function getBypassInfo(permission: PermissionState): {
  allowBypass?: boolean;
  streamId?: string;
} {
  switch (permission.kind) {
    case PERMISSION_KIND.TOOL_EDIT:
    case PERMISSION_KIND.BASH:
    case PERMISSION_KIND.EXTERNAL_INQUIRY:
    case PERMISSION_KIND.USER_QUESTION:
      return {
        allowBypass: permission.data.allowBypass,
        streamId: permission.data.streamId,
      };
    case PERMISSION_KIND.RETRY:
    case PERMISSION_KIND.PROPOSAL:
    case PERMISSION_KIND.PLAN_APPROVAL:
      return {};
  }
}

export abstract class BaseFeedbackPanel<
  K extends PermissionState['kind'] = PermissionState['kind'],
> extends BaseRequestPanel<K> {
  @query('[data-feedback-input]') private feedbackInput?: HTMLElement;
  @state() protected showFeedback = false;

  // ===========================================================================
  // Keyboard shortcuts (common y/n/escape, subclasses add type-specific keys)
  // ===========================================================================

  override handleKeyboardShortcut(key: string): boolean {
    // Read-only trace-viewer export: no action can reach a live backend, so
    // none of the accelerators should appear to do anything either.
    if (this.archived) return false;
    switch (key) {
      case 'y':
        this.emitAction('approve');
        return true;
      case 'n':
        this.handleRejectAction();
        return true;
      case 'escape':
        if (this.showFeedback) {
          this.showFeedback = false;
          return true;
        }
        return false;
      case 'a':
        // Session-bypass ("Yolo") accelerator. A no-op (returns false) on
        // prompts that don't allow bypass or while the feedback box is open,
        // so it only acts on the edit/bash prompts that surface the affordance.
        return this.handleApproveSessionKey();
      default:
        return this.handleExtraKey(key);
    }
  }

  /** Override in subclasses to handle type-specific keys (d, s, etc). */
  protected handleExtraKey(_key: string): boolean {
    return false;
  }

  // ===========================================================================
  // Feedback handling
  // ===========================================================================

  protected handleRejectAction(): void {
    if (!FEEDBACK_ELIGIBLE_KINDS.has(this.permission.kind)) {
      this.emitAction('reject');
      return;
    }

    if (!this.showFeedback) {
      this.showFeedback = true;
      this.updateComplete.then(() => {
        this.feedbackInput?.focus();
      });
      return;
    }

    const feedback = this.getFeedbackValue();
    this.showFeedback = false;
    this.emitAction('reject', feedback);
  }

  /**
   * Standard approve/reject panel shell: the BEM block with its
   * `--feedback-active` modifier, `__details`, `__actions` (approve/reject
   * plus optional extra buttons), and `__feedback` section. Keeps the class
   * structure that `requestPanelSharedStyles` targets defined in one place.
   */
  protected renderRequestShell(options: {
    /** BEM block name, e.g. 'approval-request'. */
    prefix: string;
    details: TemplateResult;
    approveTitle: string;
    rejectTitle: string;
    /** Extra action buttons rendered before the approve button. */
    leadingActions?: TemplateResult | typeof nothing;
    /** Extra action buttons rendered between approve and reject. */
    middleActions?: TemplateResult | typeof nothing;
    /** Extra action buttons rendered after the reject button. */
    trailingActions?: TemplateResult | typeof nothing;
    feedbackPlaceholder?: string;
    /** Content rendered after the feedback section (e.g. an inline diff). */
    trailing?: TemplateResult | typeof nothing;
  }): TemplateResult {
    const { prefix } = options;
    return html`
      <div
        class=${classMap({
          [prefix]: true,
          [`${prefix}--feedback-active`]: this.showFeedback,
        })}
      >
        <div class="${prefix}__details">${options.details}</div>
        <div class="${prefix}__actions">
          ${options.leadingActions ?? nothing}
          ${this.renderApproveButton(options.approveTitle)}
          ${options.middleActions ?? nothing}
          ${this.renderRejectButton(options.rejectTitle)}
          ${options.trailingActions ?? nothing}
        </div>
        ${this.renderFeedbackSection(
          `${prefix}__feedback`,
          `${prefix}__feedback-input`,
          options.feedbackPlaceholder,
        )}
        ${options.trailing ?? nothing}
      </div>
    `;
  }

  protected renderApproveButton(approveTitle: string): TemplateResult {
    // Declarative: the <approve-split-button> component owns the plain-vs-split
    // rendering and the menu's keyboard-accessible selection. When the prompt
    // allows session bypass it surfaces "Yolo (this session)" under the Approve
    // caret; selecting it (or the `a` shortcut) approves AND auto-approves edits
    // + bash for the rest of the stream.
    return html`
      <approve-split-button
        .approveTitle=${approveTitle}
        .canBypass=${this.canBypass}
        .disabled=${this.archived}
        @approve=${() => this.emitAction('approve')}
        @approve-session=${() => this.emitAction(APPROVE_SESSION_ACTION)}
      ></approve-split-button>
    `;
  }

  /**
   * Whether this prompt advertises the session-bypass ("Yolo") affordance.
   * Only tool-edit and bash permissions carry `allowBypass`; it is true exactly
   * when the stream is not already auto-approving (a bypassed stream never
   * prompts, so a visible prompt always means bypass is currently off). Also
   * requires a concrete `streamId`: session bypass is per-stream, so without one
   * there is nothing to scope it to and the button would silently no-op.
   */
  protected get canBypass(): boolean {
    const { allowBypass, streamId } = getBypassInfo(this.permission);
    return Boolean(allowBypass && streamId);
  }

  /**
   * Handle the shared `a` = approve-session shortcut — the keyboard accelerator
   * for the Approve menu's "Yolo (this session)" item, wired from
   * `handleKeyboardShortcut`. No-op while the feedback textarea is open (so
   * typing "a" there is not hijacked) or when the prompt does not allow bypass.
   */
  protected handleApproveSessionKey(): boolean {
    if (this.showFeedback || !this.canBypass) {
      return false;
    }
    this.emitAction(APPROVE_SESSION_ACTION);
    return true;
  }

  protected renderRejectButton(rejectTitle: string): TemplateResult {
    return renderLabeledActionButton({
      icon: this.showFeedback ? 'check' : 'close',
      text: this.showFeedback ? 'Submit' : 'Reject',
      title: this.showFeedback ? 'Submit rejection (n)' : rejectTitle,
      action: 'reject',
      disabled: this.archived,
      onClick: () => this.handleRejectAction(),
    });
  }

  protected renderFeedbackSection(
    containerClass: string,
    inputClass: string,
    placeholder = 'Why are you rejecting?',
  ): TemplateResult | typeof nothing {
    if (
      !this.showFeedback ||
      !FEEDBACK_ELIGIBLE_KINDS.has(this.permission.kind)
    ) {
      return nothing;
    }

    return html`
      <div class=${containerClass}>
        <wa-textarea
          class=${inputClass}
          placeholder=${placeholder}
          rows="3"
          data-feedback-input
        ></wa-textarea>
      </div>
    `;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private getFeedbackValue(): string | undefined {
    const trimmed = (
      (this.feedbackInput as HTMLElement & { value?: string })?.value ?? ''
    ).trim();
    return trimmed || undefined;
  }
}
