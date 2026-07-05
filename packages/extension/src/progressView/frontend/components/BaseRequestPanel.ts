/** Base class shared by all request panel types. */

// Third-party imports
import { LitElement } from 'lit';
import { consume } from '@lit/context';
import { property } from 'lit/decorators.js';

// Local imports - progress view events
import { ProgressEvents } from '../events';

// Local imports - progress view contexts
import { archivedContext } from '../contexts/streamContexts';

// Local imports - progress view component types
import type { PermissionState } from '../permissionState';

export abstract class BaseRequestPanel<
  K extends PermissionState['kind'] = PermissionState['kind'],
> extends LitElement {
  @property({ attribute: false }) permission!: Extract<
    PermissionState,
    { kind: K }
  >;

  /**
   * True in the read-only trace-viewer export, where there is no live
   * backend for a permission action to reach. The single chokepoint every
   * subclass's buttons/keyboard shortcuts ultimately call through
   * (`emitAction`) no-ops here, so no subclass has to remember to check this
   * itself.
   */
  @consume({ context: archivedContext, subscribe: true })
  protected archived = false;

  /** Handle keyboard shortcut from container. Returns true if handled. */
  abstract handleKeyboardShortcut(key: string): boolean;

  protected emitAction(
    action: string,
    feedback?: string,
    modelOverride?: string,
    agentOverride?: string,
  ): void {
    if (this.archived) return;
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
