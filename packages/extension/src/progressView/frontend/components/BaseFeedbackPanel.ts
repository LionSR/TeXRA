/** Base class for request panels that support rejection feedback. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { query, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';

// Side-effect imports - register WA components
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';
import '@awesome.me/webawesome/dist/components/dropdown/dropdown.js';
import '@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';

// Local imports - shared utilities
import { FEEDBACK_ELIGIBLE_KINDS } from '@shared/utils/uiConstants';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';
import { waIcon } from '@shared/wa/webAwesomeIcons';

// Local imports - progress view events
import { APPROVE_SESSION_ACTION } from '../events';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

export abstract class BaseFeedbackPanel extends BaseRequestPanel {
  @query('[data-feedback-input]') private feedbackInput?: HTMLElement;
  @state() protected showFeedback = false;

  // ===========================================================================
  // Keyboard shortcuts (common y/n/escape, subclasses add type-specific keys)
  // ===========================================================================

  override handleKeyboardShortcut(key: string): boolean {
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
   * structure that `requestPanelStyles` targets defined in one place.
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
    const approveButton = renderLabeledActionButton({
      icon: 'check',
      text: 'Approve',
      title: approveTitle,
      action: 'approve',
      className: this.canBypass ? 'approve-split-main' : undefined,
      onClick: () => this.emitAction('approve'),
    });
    if (!this.canBypass) {
      return approveButton;
    }
    // When the prompt allows session bypass, Approve becomes a split button:
    // the main click approves once; the ▾ caret opens a menu whose "Yolo (this
    // session)" item approves AND auto-approves edits + bash for the rest of the
    // stream. Keeps the row compact while surfacing the session option right on
    // the prompt (the `a` shortcut hits the same action). Mirrors the diff
    // split-button in ToolEditRequestPanel.
    return html`
      <div class="approve-split">
        ${approveButton}
        <wa-dropdown
          class="approve-split-menu"
          placement="bottom-end"
          @wa-select=${this.handleApproveMenuSelect}
        >
          <wa-button
            slot="trigger"
            class="action-icon-button approve-split-trigger"
            appearance="plain"
            variant="neutral"
            size="small"
            type="button"
            aria-label="More approve options"
            title="Approve and stop asking for edits & bash this session (a)"
          >
            ${waIcon('chevron-down')}
          </wa-button>
          <wa-dropdown-item value=${APPROVE_SESSION_ACTION}>
            ${waIcon('shield')} Yolo (this session)
          </wa-dropdown-item>
        </wa-dropdown>
      </div>
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
    const data = this.permission.data as {
      allowBypass?: boolean;
      streamId?: string;
    };
    return Boolean(data.allowBypass && data.streamId);
  }

  /**
   * Resolve a selection from the Approve split-button menu. Its only item is
   * "Yolo (this session)"; selecting it emits the same `approveSession` action
   * as the `a` shortcut, which the event handler decomposes into an approve plus
   * a session-bypass enable (edits + bash), so it never reaches the backend
   * approval protocol.
   */
  private handleApproveMenuSelect = (
    event: CustomEvent<{ item: HTMLElement }>,
  ): void => {
    const action =
      (event.detail?.item as HTMLElement & { value?: string })?.value ?? '';
    if (action === APPROVE_SESSION_ACTION) {
      this.emitAction(APPROVE_SESSION_ACTION);
    }
  };

  /**
   * Handle the shared `a` = approve-session shortcut — the keyboard accelerator
   * for the Approve menu's "Yolo (this session)" item. Subclasses that offer the
   * Yolo affordance call this from `handleExtraKey`. No-op while the feedback
   * textarea is open (so typing "a" there is not hijacked) or when the prompt
   * does not allow bypass.
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
