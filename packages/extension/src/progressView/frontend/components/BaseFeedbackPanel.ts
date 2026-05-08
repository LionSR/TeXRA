/**
 * Base class for request panels that support rejection feedback.
 *
 * Adds feedback state, reject/feedback rendering, and common keyboard
 * shortcuts (y/n/escape) on top of BaseRequestPanel.
 * ToolEdit, Bash, and Proposal panels extend this.
 */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { query, state } from 'lit/decorators.js';

// Side-effect imports - register WA textarea component
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

// Local imports - shared utilities
import { FEEDBACK_ELIGIBLE_KINDS } from '@shared/utils/uiConstants';
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

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
