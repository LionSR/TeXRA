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
    // Both states keep the reject icon and name the consequence. Switching to
    // a checkmark labelled "Submit" made the confirm step of a rejection wear
    // the approval glyph, which is the one misreading this flow cannot afford.
    return renderLabeledActionButton({
      icon: 'xmark',
      text: this.showFeedback ? 'Send rejection' : 'Reject',
      title: this.showFeedback ? 'Send rejection (n)' : rejectTitle,
      action: 'reject',
      disabled: this.archived,
      onClick: () => this.handleRejectAction(),
    });
  }

  protected renderFeedbackSection(
    containerClass: string,
    inputClass: string,
    placeholder = 'What should the agent change?',
  ): TemplateResult | typeof nothing {
    if (!this.showFeedback) return nothing;

    // A visible label, not a placeholder doing the label's job: the
    // placeholder disappears on the first keystroke, taking the only
    // description of the field with it.
    return html`
      <div class=${containerClass}>
        <label for="feedback-input">${placeholder}</label>
        <wa-textarea
          id="feedback-input"
          class=${inputClass}
          placeholder="Optional — this is sent back to the agent"
          rows="2"
          resize="vertical"
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
