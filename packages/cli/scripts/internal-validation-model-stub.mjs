// Production stand-in for `src/agent/runtime/run/validationModel.ts`: the
// CI-only gate never opens, and the canned model never ships.
export function shouldUseInternalValidationModel() {
  return false;
}

export function validationModel() {
  throw new Error('The validation model is not available in this build.');
}
