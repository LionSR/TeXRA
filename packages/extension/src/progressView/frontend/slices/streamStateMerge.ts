import { create } from 'mutative';

import {
  createStreamState,
  type StreamMetadata,
  type StreamState,
} from '@shared/schemas';

function metadataToStreamStatePartial(
  metadata: StreamMetadata,
): Partial<StreamState> {
  return {
    ...metadata,
    ...(Object.hasOwn(metadata, 'roundStage') && {
      roundStage: metadata.roundStage ?? undefined,
    }),
    ...(Object.hasOwn(metadata, 'phaseStage') && {
      phaseStage: metadata.phaseStage ?? undefined,
    }),
  } as Partial<StreamState>;
}

/**
 * Land a backend metadata patch on a stream's frontend state. Both slices that
 * receive metadata (UPDATE_STREAMS and UPDATE_STREAM_METADATA) go through here,
 * so the three cases (no state yet, same kind, changed kind) cannot be answered
 * differently depending on which message arrived.
 */
export function mergeBackendOwnedState(
  existing: StreamState | undefined,
  metadata: StreamMetadata,
): StreamState {
  if (!existing) {
    return createStreamState(
      metadata.kind,
      metadataToStreamStatePartial(metadata),
    );
  }

  if (existing.kind !== metadata.kind) {
    // Kind changed: create fresh state with new-kind defaults, overlay metadata,
    // and preserve frontend-owned taskGroups.
    return createStreamState(metadata.kind, {
      ...metadataToStreamStatePartial(metadata),
      taskGroups: existing.taskGroups,
    });
  }

  // Overlay every backend-owned field from metadata (its own keys include
  // every required BackendOwnedFieldsSchema field plus `kind`, which the guard
  // above already ensures matches `existing.kind`) so a new field added to
  // that schema is picked up here without also updating this call site.
  return create(existing, (draft) => {
    Object.assign(draft, metadataToStreamStatePartial(metadata));
    if (!Object.hasOwn(metadata, 'substate')) {
      delete draft.substate;
    }
  });
}
