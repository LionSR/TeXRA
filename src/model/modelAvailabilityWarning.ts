/** Diagnostic sink for model-picker availability degradation. */
export type ModelAvailabilityWarningSink = (
  message: string,
  error: unknown,
) => void;

/**
 * The sink until a host installs its own: the console, mirroring
 * `consoleLogSink` in `@logger/logSink`, which is what every entry written
 * before a host installs its sink lands on. Not a no-op — the reads that
 * reach here are degradations (an unreadable key store, a stored selection
 * that no longer parses), and a host that never called
 * `setModelAvailabilityWarningSink` must not turn one into silence.
 *
 * The console rather than the logger or `platform()`: this module's callers
 * are synchronous registry readers with no Effect to yield, `src/model` has
 * no import edge to `src/logger`, and `platform()` is the ambient locator the
 * Effect migration is retiring.
 */
const consoleWarningSink: ModelAvailabilityWarningSink = (message, error) => {
  console.warn(`[modelAvailability] ${message}`, error);
};

/** The host-installed sink; the console until a host installs one. */
let warningSink: ModelAvailabilityWarningSink = consoleWarningSink;

/** Install the host's model-picker warning sink. */
export function setModelAvailabilityWarningSink(
  next: ModelAvailabilityWarningSink,
): void {
  warningSink = next;
}

/** Report a model-picker availability warning. */
export function warnModelAvailability(message: string, error: unknown): void {
  warningSink(message, error);
}
