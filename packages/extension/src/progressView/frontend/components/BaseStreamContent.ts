/**
 * Shared scaffolding for stream container components: consumes the stream and
 * permission contexts and keeps `filteredPermissions` scoped to the current
 * stream. Subclasses narrow `streamContext.streamState` and render.
 */

// Third-party imports
import { LitElement, type PropertyValues } from 'lit';
import { consume } from '@lit/context';
import { state } from 'lit/decorators.js';

// Local imports - progress view
import { filterPermissionsForStream } from '../stateUtils';
import {
  EMPTY_STREAM_CONTEXT,
  permissionsContext,
  streamStateContext,
  type StreamContextValue,
} from '../streamContexts';

// Local imports - types
import type { PermissionState } from '../permissionState';

export abstract class BaseStreamContent extends LitElement {
  @consume({ context: streamStateContext, subscribe: true })
  @state()
  protected streamContext: StreamContextValue = EMPTY_STREAM_CONTEXT;

  @consume({ context: permissionsContext, subscribe: true })
  @state()
  protected permissionContext: PermissionState[] = [];

  // Derived values - recomputed in willUpdate() before render.
  protected filteredPermissions: PermissionState[] = [];

  protected override willUpdate(changedProperties: PropertyValues): void {
    if (
      changedProperties.has('streamContext') ||
      changedProperties.has('permissionContext')
    ) {
      this.filteredPermissions = filterPermissionsForStream(
        this.permissionContext,
        this.streamContext.streamInfo?.name,
      );
    }
  }
}
