/** Base class shared by all request panel types. */

// Third-party imports
import { LitElement } from 'lit';
import { consume } from '@lit/context';
import { property } from 'lit/decorators.js';

// Local imports - shared schemas
import type { PermissionPayload } from '@shared/schemas';

// Local imports - progress view events
import {
  ProgressEvents,
  type PermissionDecision,
  type PermissionKind,
} from '../events';

// Local imports - progress view contexts
import { archivedContext } from '../streamContexts';

// Local imports - progress view component types

export abstract class BaseRequestPanel<
  K extends PermissionKind = PermissionKind,
> extends LitElement {
  @property({ attribute: false }) permission!: Extract<
    PermissionPayload,
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

  protected emitAction(decision: PermissionDecision<K>): void {
    if (this.archived) return;
    this.dispatchEvent(
      ProgressEvents.permissionAction(this.permission, decision),
    );
  }
}
