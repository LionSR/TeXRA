import { failLifecycle } from './lifecycle';
import type { AgentLifecycleState } from './types';

interface FinalizeLifecycleOptions<Phase extends string> {
  lifecycle: AgentLifecycleState<Phase>;
  runFinalize: () => Promise<void>;
  runCleanup: () => Promise<void>;
  onSuccess: () => void;
  onSecondaryError?: (error: unknown) => void;
}

export async function finalizeLifecycle<Phase extends string>({
  lifecycle,
  runFinalize,
  runCleanup,
  onSuccess,
  onSecondaryError,
}: FinalizeLifecycleOptions<Phase>): Promise<void> {
  const errors: unknown[] = [];
  if (lifecycle.error) {
    errors.push(lifecycle.error);
  }

  try {
    await runFinalize();
  } catch (error) {
    errors.push(error);
  }

  try {
    await runCleanup();
  } catch (error) {
    errors.push(error);
  }

  if (errors.length > 1 && onSecondaryError) {
    errors.slice(1).forEach((error) => onSecondaryError(error));
  }

  const primaryError = errors[0];
  if (primaryError) {
    failLifecycle(lifecycle, primaryError);
    return;
  }

  onSuccess();
}
