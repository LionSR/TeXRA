/** Base class shared by all request panel types. */

// Third-party imports
import { LitElement } from 'lit';
import { property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { PermissionPayload } from '@shared/schemas';
import {
  approvalDecisionArms,
  type SurfaceDecision,
} from '@shared/session/approvalDecision';
import type { RuntimeRequest } from '@shared/session/runtimeRequest';
import { SessionUiEvents } from '@shared/session/uiEvents';

export abstract class BaseRequestPanel<
  K extends PermissionPayload['kind'] = PermissionPayload['kind'],
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

  protected emitAction(decision: SurfaceDecision): void {
    if (this.readOnly) return;
    for (const arm of approvalDecisionArms(this.permission, decision)) {
      if ('host' in arm) this.dispatchEvent(SessionUiEvents.host(arm.host));
      else this.emitRuntimeArm(arm.runtime);
    }
  }

  /**
   * One runtime arm of a decision. A panel whose host answers a runtime arm
   * with a verb of its own (the tool-edit panel's approve/reject) overrides
   * this instead of re-implementing the loop and its gate above.
   */
  protected emitRuntimeArm(runtime: RuntimeRequest): void {
    this.dispatchEvent(SessionUiEvents.runtime(runtime));
  }
}
