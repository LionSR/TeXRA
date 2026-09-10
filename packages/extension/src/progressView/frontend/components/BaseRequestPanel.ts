/** Base class shared by all request panel types. */

// Third-party imports
import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { PermissionPayload } from '@shared/schemas';
import {
  approvalDecisionArms,
  type PermissionDecision,
  type PermissionKind,
} from '@shared/session/approvalDecision';
import { SessionUiEvents } from '@shared/session/uiEvents';

export abstract class BaseRequestPanel<
  K extends PermissionKind = PermissionKind,
> extends LitElement {
  @property({ attribute: false }) permission!: Extract<
    PermissionPayload,
    { kind: K }
  >;

  /**
   * The stream's `readOnly` (PRD 5.2): another live owner holds it, it is
   * unreadable, or the surface is an archived export with no backend for a
   * decision to reach. The single chokepoint every subclass's buttons and
   * keyboard shortcuts call through (`emitAction`) no-ops here, so no
   * subclass has to remember to check this itself.
   */
  @property({ type: Boolean }) readOnly = false;

  /** Handle keyboard shortcut from container. Returns true if handled. */
  abstract handleKeyboardShortcut(key: string): boolean;

  protected emitAction(decision: PermissionDecision<K>): void {
    if (this.readOnly) return;
    for (const arm of approvalDecisionArms(this.permission, decision)) {
      this.dispatchEvent(
        'runtime' in arm
          ? SessionUiEvents.runtime(arm.runtime)
          : SessionUiEvents.host(arm.host),
      );
    }
  }
}
