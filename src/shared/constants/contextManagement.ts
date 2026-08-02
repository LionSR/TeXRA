/**
 * Default client-side compaction threshold (%), shared by the backend
 * default (`ModelHandler.getCompactionThresholdPercent`) and the
 * progress-view gauge that renders the compaction tick mark. Must match
 * `texra.model.compactionThresholdPercent` default in package.json.
 */
export const DEFAULT_COMPACTION_THRESHOLD_PERCENT = 75;
