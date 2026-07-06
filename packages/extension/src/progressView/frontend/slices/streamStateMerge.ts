import { create } from 'mutative';

import {
  createStreamState,
  type StreamMetadata,
  type StreamState,
} from '@shared/schemas';

export function metadataToStreamStatePartial(
  metadata: StreamMetadata,
): Partial<StreamState> {
  return {
    ...metadata,
    ...(Object.hasOwn(metadata, 'roundStage') && {
      roundStage: metadata.roundStage ?? undefined,
    }),
  } as Partial<StreamState>;
}

export function mergeBackendOwnedState(
  existing: StreamState,
  metadata: StreamMetadata,
): StreamState {
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
