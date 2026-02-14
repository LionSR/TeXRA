/**
 * Base class for request panels that support rejection feedback.
 *
 * Provides shared feedback state management, reject/feedback rendering,
 * and action emission. ToolEdit, Bash, and Proposal panels extend this.
 * RetryRequestPanel does NOT extend this (no feedback support).
 */

// Third-party imports
import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { property, state } from 'lit/decorators.js';

// Local imports - shared utilities
import { FEEDBACK_ELIGIBLE_KINDS } from '@shared/utils/uiConstants';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - progress view component types
import type { PermissionState } from './PermissionCard';

export abstract class BaseFeedbackPanel extends LitElement {
  @property({ attribute: false }) permission!: PermissionState;

  @state() protected showFeedback = false;

  /** Subclasses must implement keyboard shortcut handling. */
  abstract handleKeyboardShortcut(key: string): boolean;

  // ===========================================================================
  // Feedback handling (shared across ToolEdit, Bash, Proposal)
  // ===========================================================================

  protected handleRejectAction(): void {
    if (!FEEDBACK_ELIGIBLE_KINDS.has(this.permission.kind)) {
      this.emitAction('reject');
      return;
    }

    if (!this.showFeedback) {
      this.showFeedback = true;
      this.updateComplete.then(() => {
        const input =
          this.renderRoot.querySelector<HTMLElement>('[data-feedback-input]');
        input?.focus();
      });
      return;
    }

    const feedback = this.getFeedbackValue();
    this.showFeedback = false;
    this.emitAction('reject', feedback);
  }

  protected renderRejectButton(rejectTitle: string): TemplateResult {
    return html`
      <vscode-toolbar-button
        icon=${this.showFeedback ? 'check' : 'close'}
        label=${this.showFeedback ? 'Submit' : 'Reject'}
        title=${this.showFeedback ? 'Submit rejection (n)' : rejectTitle}
        @click=${() => this.handleRejectAction()}
        >${this.showFeedback ? 'Submit' : 'Reject'}</vscode-toolbar-button
      >
    `;
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
        <vscode-textarea
          class=${inputClass}
          placeholder=${placeholder}
          rows="3"
          data-feedback-input
        ></vscode-textarea>
      </div>
    `;
  }

  // ===========================================================================
  // Action emission
  // ===========================================================================

  protected emitAction(
    action: string,
    feedback?: string,
    modelOverride?: string,
  ): void {
    this.dispatchEvent(
      ProgressEvents.permissionAction({
        permission: this.permission,
        action,
        feedback,
        modelOverride,
      }),
    );
  }

  // ===========================================================================
  // Utilities
  // ===========================================================================

  private getFeedbackValue(): string | undefined {
    const input = this.renderRoot.querySelector<HTMLElement>(
      '[data-feedback-input]',
    ) as HTMLElement & { value?: string };
    const trimmed = (input?.value ?? '').trim();
    return trimmed || undefined;
  }
}
