// Production stand-in for `src/agent/runtime/run/validationModel.ts`: the
// CI-only gate never opens (an Effect of `false`, matching the real module's
// Effect-returning gate), and the canned model never ships.
import { Effect } from 'effect';

export function shouldUseInternalValidationModel() {
  return Effect.succeed(false);
}

export function validationModel() {
  throw new Error('The validation model is not available in this build.');
}
