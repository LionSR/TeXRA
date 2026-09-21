/** Diagnostic sink for model-picker availability degradation. */
export type ModelAvailabilityWarningSink = (
  message: string,
  error: unknown,
) => void;

/** The host-installed sink; stays silent until the host installs one. */
let warningSink: ModelAvailabilityWarningSink = () => {};

/** Install the host's model-picker warning sink. */
export function setModelAvailabilityWarningSink(
  next: ModelAvailabilityWarningSink,
): void {
  warningSink = next;
}

/** Report a model-picker availability warning when the host has a sink. */
export function warnModelAvailability(message: string, error: unknown): void {
  warningSink(message, error);
}
