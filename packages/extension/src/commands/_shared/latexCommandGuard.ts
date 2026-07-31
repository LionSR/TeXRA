// Local imports
import {
  withLaTeXGuard,
  type ActiveFileGuardSuccess,
  type LaTeXGuardOptions,
} from '@frontend/editor/activeFileGuards';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';

export interface GuardedLatexCommandOptions extends LaTeXGuardOptions {
  /** Message surfaced and logged when the operation throws. */
  errorMessage: string;
}

/**
 * Run a LaTeX entry-point command under the active-file guard, surfacing any
 * thrown error through the command's channel logger. Shared by the LaTeX,
 * figure, and linter command modules, which otherwise repeat the same
 * `try/withLaTeXGuard/catch` frame around every handler.
 */
export async function runGuardedLatexCommand(
  options: GuardedLatexCommandOptions,
  operation: (guardResult: ActiveFileGuardSuccess) => Promise<void>,
): Promise<void> {
  const { errorMessage, ...guard } = options;
  try {
    await withLaTeXGuard(guard, operation);
  } catch (err) {
    await showLoggedErrorMessage(guard.channel, errorMessage, err);
  }
}
