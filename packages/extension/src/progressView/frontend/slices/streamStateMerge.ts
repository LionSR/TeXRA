import { create } from 'mutative';

import {
  createStreamState,
  type StreamMetadata,
  type StreamState,
} from '@shared/schemas';

function metadataToStreamStatePartial(
  metadata: StreamMetadata,
): Partial<StreamState> {
  // `category` is the state union's discriminant, owned by the create/guard
  // logic in `mergeBackendOwnedState` — never spread it into a patch.
  const { category: _category, ...backendFields } = metadata;
  return {
    ...backendFields,
    ...(Object.hasOwn(metadata, 'stage') && {
      stage: metadata.stage ?? undefined,
    }),
  } as Partial<StreamState>;
}

/**
 * Land a backend metadata patch on a stream's frontend state. Both slices that
 * receive metadata (UPDATE_STREAMS and UPDATE_STREAM_METADATA) go through here,
 * so the three cases (no state yet, same category, changed category) cannot be
 * answered differently depending on which message arrived.
 */
export function mergeBackendOwnedState(
  existing: StreamState | undefined,
  metadata: StreamMetadata,
): StreamState | undefined {
  if (!existing) {
    // No state and no resolved category: the stream is still pending — there
    // is no arm to create, and fabricating one (the old `?? Workflow`) is
    // exactly the misclassification this shape exists to prevent.
    if (!metadata.category) return undefined;
    return createStreamState(
      metadata.category,
      metadataToStreamStatePartial(metadata),
    );
  }

  if (metadata.category && existing.category !== metadata.category) {
    // Category changed: create fresh state with new-category defaults,
    // overlay metadata, and preserve frontend-owned taskGroups.
    return createStreamState(metadata.category, {
      ...metadataToStreamStatePartial(metadata),
      taskGroups: existing.taskGroups,
    });
  }

  // Overlay every backend-owned field from metadata (its own keys include
  // every required BackendOwnedFieldsSchema field) so a new field added to
  // that schema is picked up here without also updating this call site.
  return create(existing, (draft) => {
    Object.assign(draft, metadataToStreamStatePartial(metadata));
    if (!Object.hasOwn(metadata, 'substate')) {
      delete draft.substate;
    }
    if (!Object.hasOwn(metadata, 'runStartedAt')) {
      delete draft.runStartedAt;
    }
  });
}
