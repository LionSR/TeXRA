import { z } from 'zod';

import { getSupportedImageExtension } from '@shared/utils/clipboardImages';

export const MAX_FOLLOW_UP_IMAGES = 8;
export const MAX_FOLLOW_UP_IMAGE_BASE64_BYTES = 3 * 1024 * 1024;
export const MAX_FOLLOW_UP_PERSISTED_STREAMS = 20;
export const MAX_FOLLOW_UP_PAYLOAD_BYTES = 4 * 1024 * 1024;
export const MAX_FOLLOW_UP_TEXT_LENGTH = 256 * 1024;
export const MAX_FOLLOW_UP_ID_LENGTH = 256;
export const MAX_FOLLOW_UP_ERROR_LENGTH = 1024;
export const MAX_FOLLOW_UP_FILE_NAME_LENGTH = 255;
export const MAX_FOLLOW_UP_MEDIA_TYPE_LENGTH = 64;
export const MAX_FOLLOW_UP_FINGERPRINT_LENGTH = 128;

const CanonicalBase64Schema = z
  .string()
  .min(1)
  .max(MAX_FOLLOW_UP_IMAGE_BASE64_BYTES)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
    'Expected canonical base64.',
  );

const FollowUpImageFileNameSchema = z
  .string()
  .min(1)
  .max(MAX_FOLLOW_UP_FILE_NAME_LENGTH)
  .regex(/^pasted_[^/\\\0]+\.[A-Za-z0-9]+$/, 'Invalid pasted image filename.');

/** Canonical renderer image shape accepted at persistence and IPC boundaries. */
export const FollowUpImageSchema = z
  .object({
    base64: CanonicalBase64Schema,
    mediaType: z
      .string()
      .min(1)
      .max(MAX_FOLLOW_UP_MEDIA_TYPE_LENGTH)
      .refine(
        (value) => getSupportedImageExtension(value) !== undefined,
        'Unsupported image media type.',
      ),
    fileName: FollowUpImageFileNameSchema,
  })
  .refine(
    (image) => {
      const extension = image.fileName.slice(
        image.fileName.lastIndexOf('.') + 1,
      );
      return (
        getSupportedImageExtension(image.mediaType) === extension.toLowerCase()
      );
    },
    { message: 'Image media type and filename do not match.' },
  );

/** Measure the serialized payload at persistence and IPC trust boundaries. */
export function serializedFollowUpPayloadBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    return serialized === undefined
      ? Number.POSITIVE_INFINITY
      : new TextEncoder().encode(serialized).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
