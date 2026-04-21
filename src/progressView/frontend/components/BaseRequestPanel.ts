/**
 * Minimal base class shared by all 4 request panel types.
 *
 * Provides the `permission` property, `emitAction()` helper, and the
 * `handleKeyboardShortcut()` contract that the container delegates to.
 *
 * BaseFeedbackPanel extends this to add reject-feedback support.
 * RetryRequestPanel extends this directly (no feedback).
 */

// Third-party imports
import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - progress view component types
import type { PermissionState } from './PermissionCard';

export abstract class BaseRequestPanel extends LitElement {
  @property({ attribute: false }) permission!: PermissionState;

  /** Handle keyboard shortcut from container. Returns true if handled. */
  abstract handleKeyboardShortcut(key: string): boolean;

  protected emitAction(
    action: string,
    feedback?: string,
    modelOverride?: string,
    agentOverride?: string,
  ): void {
    this.dispatchEvent(
      ProgressEvents.permissionAction({
        permission: this.permission,
        action,
        feedback,
        modelOverride,
        agentOverride,
      }),
    );
  }
}
