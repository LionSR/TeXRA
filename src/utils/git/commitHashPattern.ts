/**
 * Hex-digit range for an abbreviated or full git commit hash. Git accepts an
 * abbreviated hash as short as 4 characters (shorter prefixes risk
 * ambiguity) up to a full 40-character SHA-1. Shared so every place that
 * validates or parses a commit hash — the Overleaf/git command handlers and
 * the latexdiff filename grammar — stays in sync by construction instead of
 * by convention.
 */
export const COMMIT_HASH_HEX_RANGE = '[0-9a-fA-F]{4,40}';

/** Validates a bare, fully-anchored commit hash string. */
export const COMMIT_HASH_PATTERN = new RegExp(`^${COMMIT_HASH_HEX_RANGE}$`);
