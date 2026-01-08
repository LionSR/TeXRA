/**
 * Shared constants for context management across model handlers.
 * Single source of truth for compaction/truncation settings.
 */

/**
 * Default compaction threshold percentage.
 * When context utilization exceeds this percentage of the model's context window,
 * context management (compaction, truncation, or clearing) is triggered.
 *
 * This value must match the default in package.json for:
 * - texra.model.compactionThresholdPercent
 *
 * Set to 0 to disable context management entirely.
 */
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 75;
