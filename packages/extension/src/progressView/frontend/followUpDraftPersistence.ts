import { create } from 'mutative';
import { z } from 'zod';

import {
  FollowUpAttachmentFingerprintSchema,
  FollowUpImageSchema,
  FollowUpSubmissionStateSchema,
  MAX_FOLLOW_UP_ERROR_LENGTH,
  MAX_FOLLOW_UP_FILE_NAME_LENGTH,
  MAX_FOLLOW_UP_FINGERPRINT_LENGTH,
  MAX_FOLLOW_UP_ID_LENGTH,
  MAX_FOLLOW_UP_IMAGE_BASE64_BYTES,
  MAX_FOLLOW_UP_IMAGES,
  MAX_FOLLOW_UP_MEDIA_TYPE_LENGTH,
  MAX_FOLLOW_UP_PAYLOAD_BYTES,
  MAX_FOLLOW_UP_PERSISTED_STREAMS,
  MAX_FOLLOW_UP_TEXT_LENGTH,
  serializedFollowUpPayloadBytes,
  type StreamTabId,
  type ToolUseStreamState,
} from '@shared/schemas';

import {
  fingerprintFollowUpImage,
  getFollowUpInputTransientState,
} from './followUpInputState';
import { appState } from './progressState';
import { isToolUseState, type ProgressState } from './store';
import { webviewStorage } from './webviewStorage';

const PERSISTED_FOLLOW_UP_DRAFTS_KEY = 'followUpDrafts:v1';

const PersistedAttachmentSchema = FollowUpImageSchema.and(
  z.object({ fingerprint: FollowUpAttachmentFingerprintSchema }),
);

const PersistedDraftSchema = z.object({
  text: z.string().max(MAX_FOLLOW_UP_TEXT_LENGTH),
  submission: FollowUpSubmissionStateSchema.nullable(),
  attachments: z.array(PersistedAttachmentSchema).max(MAX_FOLLOW_UP_IMAGES),
  updatedAt: z.number().finite(),
});

const PersistedDraftEnvelopeSchema = z.object({
  version: z.literal(1),
  drafts: z.record(
    z.string().min(1).max(MAX_FOLLOW_UP_ID_LENGTH),
    PersistedDraftSchema,
  ),
});

type PersistedDraft = z.infer<typeof PersistedDraftSchema>;
type FollowUpSubmission = ToolUseStreamState['ui']['followUpSubmission'];

/** Make an unconfirmed delivery retryable without changing its identity. */
export function recoverInterruptedFollowUpSubmission(
  submission: FollowUpSubmission,
): FollowUpSubmission {
  return submission?.status === 'sending'
    ? {
        ...submission,
        status: 'failed',
        error: 'Delivery status was not confirmed. Try again.',
      }
    : submission;
}

export type PersistFollowUpDraftResult =
  | { readonly persisted: true }
  | { readonly persisted: false; readonly error: string };

let drafts = new Map<StreamTabId, PersistedDraft>();
let pendingRestore = new Set<StreamTabId>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function boundedString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength;
}

/** Cheap shape and size checks that run before Zod regexes or fingerprints. */
function isBoundedPersistedEnvelope(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.drafts)) {
    return false;
  }
  const entries = Object.entries(value.drafts);
  if (entries.length > MAX_FOLLOW_UP_PERSISTED_STREAMS) return false;
  for (const [streamId, draftValue] of entries) {
    if (!boundedString(streamId, MAX_FOLLOW_UP_ID_LENGTH)) return false;
    if (!isRecord(draftValue)) return false;
    if (!boundedString(draftValue.text, MAX_FOLLOW_UP_TEXT_LENGTH))
      return false;
    if (!Array.isArray(draftValue.attachments)) return false;
    if (draftValue.attachments.length > MAX_FOLLOW_UP_IMAGES) return false;
    for (const attachment of draftValue.attachments) {
      if (!isRecord(attachment)) return false;
      if (
        !boundedString(attachment.base64, MAX_FOLLOW_UP_IMAGE_BASE64_BYTES) ||
        !boundedString(attachment.fileName, MAX_FOLLOW_UP_FILE_NAME_LENGTH) ||
        !boundedString(attachment.mediaType, MAX_FOLLOW_UP_MEDIA_TYPE_LENGTH) ||
        !boundedString(attachment.fingerprint, MAX_FOLLOW_UP_FINGERPRINT_LENGTH)
      ) {
        return false;
      }
    }
    const submission = draftValue.submission;
    if (submission !== null) {
      if (!isRecord(submission)) return false;
      if (
        !boundedString(submission.deliveryId, MAX_FOLLOW_UP_ID_LENGTH) ||
        !boundedString(submission.text, MAX_FOLLOW_UP_TEXT_LENGTH) ||
        !Array.isArray(submission.attachmentFingerprints) ||
        submission.attachmentFingerprints.length > MAX_FOLLOW_UP_IMAGES ||
        submission.attachmentFingerprints.some(
          (fingerprint) =>
            !boundedString(fingerprint, MAX_FOLLOW_UP_FINGERPRINT_LENGTH),
        ) ||
        (submission.status !== 'sending' && submission.status !== 'failed') ||
        (submission.status === 'failed' &&
          (!boundedString(submission.error, MAX_FOLLOW_UP_ERROR_LENGTH) ||
            submission.error.length === 0))
      ) {
        return false;
      }
    }
    if (typeof draftValue.updatedAt !== 'number') return false;
  }
  return serializedFollowUpPayloadBytes(value) <= MAX_FOLLOW_UP_PAYLOAD_BYTES;
}

/** Commit a complete candidate without changing the last-known-good map on failure. */
function writeDrafts(
  candidateDrafts: Map<StreamTabId, PersistedDraft>,
): PersistFollowUpDraftResult {
  if (candidateDrafts.size > MAX_FOLLOW_UP_PERSISTED_STREAMS) {
    return {
      persisted: false,
      error: 'Follow-up storage is full. Clear an older draft, then try again.',
    };
  }
  const envelope = {
    version: 1 as const,
    drafts: Object.fromEntries(candidateDrafts),
  };
  if (serializedFollowUpPayloadBytes(envelope) > MAX_FOLLOW_UP_PAYLOAD_BYTES) {
    return {
      persisted: false,
      error:
        'The follow-up is too large to preserve safely. Remove an image or shorten the message, then try again.',
    };
  }
  try {
    webviewStorage.set(PERSISTED_FOLLOW_UP_DRAFTS_KEY, envelope);
  } catch {
    return {
      persisted: false,
      error:
        'The follow-up could not be saved in this window. Free storage or reload TeXRA, then try again.',
    };
  }
  drafts = candidateDrafts;
  return { persisted: true };
}

/**
 * Load the one webview-scoped follow-up persistence authority before the ready
 * handshake. Attachment bytes stay in VS Code webview state or the desktop
 * app's user-data state only. They never enter workspace storage or logs.
 */
export function prepareFollowUpDraftRestore(): void {
  const stored = webviewStorage.get(PERSISTED_FOLLOW_UP_DRAFTS_KEY);
  const parsed = isBoundedPersistedEnvelope(stored)
    ? PersistedDraftEnvelopeSchema.safeParse(stored)
    : undefined;
  if (parsed?.success) {
    drafts = new Map(
      Object.entries(parsed.data.drafts).map(([streamId, draft]) => [
        streamId as StreamTabId,
        draft,
      ]),
    );
  } else {
    drafts = new Map();
    if (stored !== undefined) {
      try {
        webviewStorage.delete(PERSISTED_FOLLOW_UP_DRAFTS_KEY);
      } catch {
        // A disabled host store must not block a clean in-memory restore.
      }
    }
  }
  pendingRestore = new Set(drafts.keys());
}

/** Apply each prepared draft once its stream has complete tool-use metadata. */
export function applyPreparedFollowUpDrafts(
  state: ProgressState,
): ProgressState {
  if (pendingRestore.size === 0) return state;
  const restorable = new Map<StreamTabId, PersistedDraft>();
  const invalid = new Set<StreamTabId>();
  for (const streamId of pendingRestore) {
    const streamState = state.streamStates.get(streamId);
    if (!streamState || !isToolUseState(streamState)) continue;
    const draft = drafts.get(streamId);
    if (!draft) {
      pendingRestore.delete(streamId);
      continue;
    }
    const attachments = draft.attachments.map(
      ({ fingerprint: _fingerprint, ...attachment }) => attachment,
    );
    if (
      attachments.some(
        (attachment, index) =>
          fingerprintFollowUpImage(attachment) !==
          draft.attachments[index]?.fingerprint,
      )
    ) {
      invalid.add(streamId);
      continue;
    }
    getFollowUpInputTransientState(streamId).pendingImages = attachments;
    restorable.set(streamId, draft);
  }
  const restored = create(state, (next) => {
    for (const [streamId, draft] of restorable) {
      const streamState = next.streamStates.get(streamId);
      if (!streamState || !('ui' in streamState)) continue;
      streamState.ui.followUpText = draft.text;
      streamState.ui.followUpSubmission = draft.submission;
    }
  });
  for (const streamId of restorable.keys()) pendingRestore.delete(streamId);
  if (invalid.size > 0) {
    const candidateDrafts = new Map(drafts);
    for (const streamId of invalid) {
      candidateDrafts.delete(streamId);
      pendingRestore.delete(streamId);
    }
    writeDrafts(candidateDrafts);
  }
  return restored;
}

/** Persist one complete stream snapshot without evicting any other draft. */
export function persistFollowUpDraft(
  streamId: StreamTabId,
): PersistFollowUpDraftResult {
  if (streamId.length > MAX_FOLLOW_UP_ID_LENGTH) {
    return { persisted: false, error: 'This run identifier is invalid.' };
  }
  const streamState = appState.get().streamStates.get(streamId);
  const candidateDrafts = new Map(drafts);
  if (!streamState || !isToolUseState(streamState)) {
    candidateDrafts.delete(streamId);
    pendingRestore.delete(streamId);
    return writeDrafts(candidateDrafts);
  }
  if (streamState.ui.followUpText.length > MAX_FOLLOW_UP_TEXT_LENGTH) {
    return {
      persisted: false,
      error: 'The message is too long. Shorten it and try again.',
    };
  }
  const attachments = getFollowUpInputTransientState(streamId).pendingImages;
  if (attachments.length > MAX_FOLLOW_UP_IMAGES) {
    return {
      persisted: false,
      error: `Attach no more than ${MAX_FOLLOW_UP_IMAGES} images, then try again.`,
    };
  }
  if (
    attachments.some(
      (attachment) =>
        attachment.base64.length > MAX_FOLLOW_UP_IMAGE_BASE64_BYTES,
    )
  ) {
    return {
      persisted: false,
      error:
        'Each image must be 3 MiB or smaller. Remove the large image, then try again.',
    };
  }
  const preflightEnvelope = {
    version: 1,
    drafts: {
      ...Object.fromEntries(candidateDrafts),
      [streamId]: {
        text: streamState.ui.followUpText,
        submission: streamState.ui.followUpSubmission,
        attachments: attachments.map((attachment) => ({
          ...attachment,
          fingerprint: '',
        })),
        updatedAt: Date.now(),
      },
    },
  };
  if (
    serializedFollowUpPayloadBytes(preflightEnvelope) >
    MAX_FOLLOW_UP_PAYLOAD_BYTES
  ) {
    return {
      persisted: false,
      error:
        'The follow-up is too large to preserve safely. Remove an image or shorten the message, then try again.',
    };
  }
  const parsedAttachments = z.array(FollowUpImageSchema).safeParse(attachments);
  if (!parsedAttachments.success) {
    return {
      persisted: false,
      error:
        'One or more images are invalid. Remove and paste them again, then try again.',
    };
  }
  const draft: PersistedDraft = {
    text: streamState.ui.followUpText,
    submission: streamState.ui.followUpSubmission,
    attachments: parsedAttachments.data.map((attachment) => ({
      ...attachment,
      fingerprint: fingerprintFollowUpImage(attachment),
    })),
    updatedAt: Date.now(),
  };
  if (
    !draft.text &&
    draft.submission === null &&
    draft.attachments.length === 0
  ) {
    candidateDrafts.delete(streamId);
    pendingRestore.delete(streamId);
    return writeDrafts(candidateDrafts);
  }
  candidateDrafts.set(streamId, draft);
  pendingRestore.delete(streamId);
  return writeDrafts(candidateDrafts);
}

export function deletePersistedFollowUpDraft(streamId: StreamTabId): void {
  const candidateDrafts = new Map(drafts);
  candidateDrafts.delete(streamId);
  pendingRestore.delete(streamId);
  writeDrafts(candidateDrafts);
}

export function clearPersistedFollowUpDrafts(): void {
  try {
    webviewStorage.delete(PERSISTED_FOLLOW_UP_DRAFTS_KEY);
    drafts.clear();
    pendingRestore.clear();
  } catch {
    // Keep the last-known-good in-memory snapshots so a later write can retry.
  }
}
