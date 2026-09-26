import { Effect, FileSystem } from 'effect';

import type { AgentTrace } from '@agent/trace';
import type { CompileFailure, CompileResult } from '@shared/schemas';
import { toErrorMessage } from '@utils/errors/errorMessage';

const COMPILE_LOG_EXCERPT_CHAR_LIMIT = 12000;

export function formatCompileFailureRoundContext(
  result: CompileResult | undefined,
): string | undefined {
  if (result?.status !== 'failed') return undefined;

  const failedOutputs = result.failures
    .map((failure) => `- ${failure.displayName} (${failure.logRelativePath})`)
    .join('\n');

  return [
    '<compile_failure_context>',
    'The previous workflow round was rejected because LaTeX compilation failed.',
    'Use the log excerpt below to repair the next output.',
    '',
    'Failed outputs:',
    failedOutputs,
    '',
    'Log excerpt:',
    result.logExcerpt.trim(),
    '</compile_failure_context>',
  ].join('\n');
}

export function appendCompileFailureRoundContext(
  userRequest: string,
  compileFailureContext: string | undefined,
): string {
  if (!compileFailureContext) return userRequest;
  const trimmedRequest = userRequest.trimEnd();
  return trimmedRequest
    ? `${trimmedRequest}\n\n${compileFailureContext}`
    : compileFailureContext;
}

/** A round's failure log excerpts as one, keeping the tail past the limit. */
export function combineFailureLogExcerpts(excerpts: string[]): string {
  const combined = excerpts.filter(Boolean).join('\n\n');
  if (combined.length <= COMPILE_LOG_EXCERPT_CHAR_LIMIT) return combined;

  return [
    `[truncated to last ${COMPILE_LOG_EXCERPT_CHAR_LIMIT} characters]`,
    combined.slice(-COMPILE_LOG_EXCERPT_CHAR_LIMIT),
  ].join('\n');
}

/**
 * A rejected round's context for the next round, rebuilt from its persisted
 * failures and the log each one wrote (`writeCompileFailure`: the excerpt
 * plus a newline), so it equals what the round's own check fed forward.
 * Undefined for no failures, and, with a warning, when a log cannot be read:
 * the rejection stands, its context does not.
 */
export const failureContextFromLogs = Effect.fn('failureContextFromLogs')(
  function* (
    failures: readonly CompileFailure[],
    logger: Pick<AgentTrace, 'warn'>,
  ): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    const excerpts: string[] = [];
    for (const failure of failures) {
      // A check that errored before writing a log records the output as it.
      const read = yield* Effect.result(
        failure.log.absolutePath === failure.output.absolutePath
          ? Effect.fail(new Error('the check errored before writing a log'))
          : fs.readFileString(failure.log.absolutePath),
      );
      if (read._tag === 'Failure') {
        logger.warn(
          `Compile log ${failure.logRelativePath} could not be read, so the next round is not told why round ${failure.round + 1} was rejected: ${toErrorMessage(read.failure)}`,
        );
        return undefined;
      }
      excerpts.push(read.success.replace(/\n$/, ''));
    }
    const [first] = failures;
    if (first === undefined) return undefined;
    return formatCompileFailureRoundContext({
      status: 'failed',
      round: first.round,
      failures: [...failures],
      logExcerpt: combineFailureLogExcerpts(excerpts),
    });
  },
);
