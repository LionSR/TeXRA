/** Diagnostic sink for model-picker availability degradation. */
export type ModelAvailabilityWarningSink = (
  message: string,
  error: unknown,
) => void;

interface ModelAvailabilityWarningSlot {
  setSink(next: ModelAvailabilityWarningSink): void;
  warn(message: string, error: unknown): void;
}

/** Build a warning slot that stays silent until the host installs a sink. */
function createModelAvailabilityWarningSlot(): ModelAvailabilityWarningSlot {
  const NOOP: ModelAvailabilityWarningSink = () => {};
  let sink = NOOP;
  return {
    setSink(next) {
      sink = next;
    },
    warn(message, error) {
      sink(message, error);
    },
  };
}

const availabilityWarnings = createModelAvailabilityWarningSlot();

/** Install the host's model-picker warning sink. */
export function setModelAvailabilityWarningSink(
  next: ModelAvailabilityWarningSink,
): void {
  availabilityWarnings.setSink(next);
}

/** Report a model-picker availability warning when the host has a sink. */
export function warnModelAvailability(message: string, error: unknown): void {
  availabilityWarnings.warn(message, error);
}
