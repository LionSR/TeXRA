import type { MediaEntry } from '@agent/utils/mediaTypes';

/**
 * The fundamental kind of a media entry, derived from its `media_category`
 * and MIME type. Every chat-style handler's `createMediaContent` (Anthropic,
 * OpenAI chat completions, OpenAI Responses) repeated the same structural
 * classification — an `'image'`-category entry whose MIME type is
 * `application/pdf` is really a PDF, any other `'image'`-category entry is a
 * plain image, an `'audio'`-category entry is audio, anything else is
 * unrecognized — before applying its own capability gating (native PDF
 * support, native audio support, accepted image MIME types) on top. This
 * function owns only the structural classification; callers still decide
 * whether they actually support what they got back.
 *
 * Google's media pipeline (`buildMedia` in `google/`) is deliberately not
 * routed through this: it dispatches on MIME-type prefix directly (including
 * a `video` kind this classification doesn't model) rather than on
 * `media_category`, and is already shared across both Google handlers via
 * `uploadGoogleMediaEntries`.
 */
export function classifyMediaEntry(
  entry: Pick<MediaEntry, 'media_category' | 'media_type'>,
): 'image' | 'audio' | 'pdf' | 'unsupported' {
  if (entry.media_category === 'image') {
    return entry.media_type === 'application/pdf' ? 'pdf' : 'image';
  }
  if (entry.media_category === 'audio') {
    return 'audio';
  }
  return 'unsupported';
}

/**
 * Standard warning for a media entry `classifyMediaEntry` could not place in
 * any known category. Shared so the handlers that route through it log
 * identical text instead of near-identical hand-written variants.
 */
export function unknownMediaCategoryWarning(
  entry: Pick<MediaEntry, 'media_category'>,
): string {
  return `Unknown media category: ${entry.media_category}`;
}
