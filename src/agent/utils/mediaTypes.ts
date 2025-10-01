/**
 * Structured representation of media data used when constructing
 * multi-modal messages before provider-specific formatting.
 */
export interface MediaEntry {
  /** File name for reference, typically without directory */
  file_name: string;
  /** Base64 encoded media content */
  data: string;
  /** Binary representation of the media payload when available */
  binaryData?: Uint8Array;
  /** MIME type of the media */
  media_type: string;
  /** Category of the media, e.g. 'image' or 'audio' */
  media_category: string;
}
