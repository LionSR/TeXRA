/**
 * Hex-digit range for an abbreviated or full git commit hash, as the
 * latexdiff filename grammar reads it: git accepts an abbreviated hash as
 * short as 4 characters (shorter prefixes risk ambiguity) up to a full
 * 40-character SHA-1.
 */
export const COMMIT_HASH_HEX_RANGE = '[0-9a-fA-F]{4,40}';
