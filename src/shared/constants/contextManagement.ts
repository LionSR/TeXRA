/**
 * Default client-side compaction threshold (%), the handler-side default
 * used by `ModelHandler.getCompactionThresholdPercent` only. Must match the
 * `texra.model.compactionThresholdPercent` default declared in the
 * core-settings catalog
 * (`DEFAULT_CORE_SETTINGS.model.compactionThresholdPercent`).
 */
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 75;
