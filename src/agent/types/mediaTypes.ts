/**
 * Structured representation of media data used when constructing
 * multi-modal messages before provider-specific formatting.
 */
export interface MediaEntry {
  /**
   * Name the model sees for this attachment. Follows `getPromptFileName`, the
   * same rule as a text document's `<document name="…">`: workspace-relative
   * for workspace files, bare basename otherwise. Provider fields that require
   * a filename (`filename`, `title`, `displayName`) basename it themselves.
   */
  file_name: string;
  /** Base64 encoded media content */
  data: string;
  /** MIME type of the media */
  media_type: string;
  /** Category of the media, e.g. 'image' or 'audio' */
  media_category: string;
  /** Absolute path to the original file when available */
  source_path?: string;
  /** Indicates whether the binary payload matches the on-disk source */
  bytes_match_source?: boolean;
}
