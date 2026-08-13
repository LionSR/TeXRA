/**
 * Structured representation of media data used when constructing
 * multi-modal messages before provider-specific formatting.
 */
export interface MediaEntry {
  /** File name for reference, typically without directory */
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
