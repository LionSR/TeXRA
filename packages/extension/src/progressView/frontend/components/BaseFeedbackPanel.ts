/** Base class for request panels that support rejection feedback. */

// Third-party imports
import { html, nothing, type TemplateResult } from 'lit';
import { query, state } from 'lit/decorators.js';

// Side-effect imports - register WA textarea
import '@awesome.me/webawesome/dist/components/textarea/textarea.js';

// Local imports - shared utilities
import { renderLabeledActionButton } from '@shared/wa/actionButtons';

// Local imports - base class
import { BaseRequestPanel } from './BaseRequestPanel';

// Local imports - progress view events
import type { FeedbackPermissionKind } from '../events';

export abstract class BaseFeedbackPanel<
  K extends FeedbackPermissionKind = FeedbackPermissionKind,
> extends BaseRequestPanel<K> {
  @query('[data-feedback-input]') private feedbackInput?: HTMLElement;
  @state() protected showFeedback = false;

  // ===========================================================================
  // Keyboard shortcuts (common n/escape, subclasses add type-specific keys)
  // ===========================================================================

  override handleKeyboardShortcut(key: string): boolean {
    // Read-only trace-viewer export: no action can reach a live backend, so
    // none of the accelerators should appear to do anything either.
    if (this.archived) return false;
    switch (key) {
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
    if (!this.showFeedback) {
      this.showFeedback = true;
      this.updateComplete.then(() => {
        this.feedbackInput?.focus();
      });
      return;
    }

    const feedback = this.getFeedbackValue();
    this.showFeedback = false;
    this.emitAction({
      action: 'reject',
      ...(feedback ? { feedback } : {}),
    });
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
    if (!this.showFeedback) return nothing;

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
