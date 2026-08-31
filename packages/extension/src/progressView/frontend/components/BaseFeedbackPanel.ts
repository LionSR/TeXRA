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

/**
 * Rejection prompt for panels that ask the agent a question rather than review
 * its work — rejecting redirects the agent instead of revising a proposal.
 */
export const REDIRECT_FEEDBACK_PROMPT = 'What should the agent do instead?';

export abstract class BaseFeedbackPanel<
  K extends FeedbackPermissionKind = FeedbackPermissionKind,
> extends BaseRequestPanel<K> {
  @query('[data-feedback-input]')
  private feedbackInput?: HTMLElementTagNameMap['wa-textarea'];
  @query('wa-button[data-action="reject"]')
  private rejectButton?: HTMLElement;
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
          this.hideFeedback();
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

  private handleFeedbackKeydown(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;

    // RequestPanels deliberately ignores shortcuts while a text field owns
    // focus. Handle Escape at the field so the advertised dismissal still
    // works, then return focus to the action that opened it.
    event.preventDefault();
    event.stopPropagation();
    this.hideFeedback();
  }

  private hideFeedback(): void {
    this.showFeedback = false;
    void this.updateComplete.then(() => this.rejectButton?.focus());
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
    prompt = 'What should the agent change?',
  ): TemplateResult | typeof nothing {
    if (!this.showFeedback) return nothing;

    // Use Web Awesome's supported label/hint API so both strings reach the
    // internal textarea's accessibility tree as well as remaining visible.
    return html`
      <div class=${containerClass}>
        <wa-textarea
          class=${inputClass}
          name="rejection-feedback"
          label=${prompt}
          hint="Optional. This note is sent to the agent."
          rows="2"
          resize="vertical"
          autocomplete="off"
          spellcheck="true"
          ?disabled=${this.archived}
          data-feedback-input
          @keydown=${this.handleFeedbackKeydown}
        ></wa-textarea>
      </div>
    `;
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private getFeedbackValue(): string | undefined {
    const trimmed = (this.feedbackInput?.value ?? '').trim();
    return trimmed || undefined;
  }
}
