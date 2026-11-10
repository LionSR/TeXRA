import { Effect, FileSystem } from 'effect';

import { toErrorMessage } from '@texra-ai/harness/schemas';
import type { CompileFailure } from '@texra/shared/plugins/documentOutputs';

const COMPILE_LOG_EXCERPT_CHAR_LIMIT = 12000;

function formatCompileFailureRoundContext(
  failures: readonly CompileFailure[],
  logExcerpt: string,
): string {
  const failedOutputs = failures
    .map((failure) => `- ${failure.displayName} (${failure.logRelativePath})`)
    .join('\n');

  return [
    '<compile_failure_context>',
    'The previous revision was rejected because LaTeX compilation failed.',
    'Use the log excerpt below to repair the next output.',
    '',
    'Failed outputs:',
    failedOutputs,
    '',
    'Log excerpt:',
    logExcerpt.trim(),
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
function combineFailureLogExcerpts(excerpts: string[]): string {
  const combined = excerpts.filter(Boolean).join('\n\n');
  if (combined.length <= COMPILE_LOG_EXCERPT_CHAR_LIMIT) return combined;

  return [
    `[truncated to last ${COMPILE_LOG_EXCERPT_CHAR_LIMIT} characters]`,
    combined.slice(-COMPILE_LOG_EXCERPT_CHAR_LIMIT),
  ].join('\n');
}

/** What a rejected round's logs give the next round: its context (none
 *  for no failures), or why there is none, for the caller to report. */
type FailureContextRead =
  | { readonly kind: 'context'; readonly text: string | undefined }
  | { readonly kind: 'unreadable'; readonly warning: string };

/**
 * A rejected round's context for the next round, rebuilt from its persisted
 * failures and the log each one wrote (`writeCompileFailure`: the excerpt
 * plus a newline), so it equals what the round's own check fed forward.
 * No text for no failures; `unreadable` when a log cannot be read: the
 * rejection stands, its context does not.
 */
export const failureContextFromLogs = Effect.fn('failureContextFromLogs')(
  function* (
    failures: readonly CompileFailure[],
  ): Effect.fn.Return<FailureContextRead, never, FileSystem.FileSystem> {
    const fs = yield* FileSystem.FileSystem;
    // The logs are read together, then taken in order: the first unreadable
    // one is the one named.
    const reads = yield* Effect.forEach(
      failures,
      (failure) => Effect.result(fs.readFileString(failure.log.absolutePath)),
      { concurrency: 8 },
    );
    const excerpts: string[] = [];
    for (const [i, failure] of failures.entries()) {
      const read = reads[i];
      if (read._tag === 'Failure') {
        return {
          kind: 'unreadable',
          warning: `Compile log ${failure.logRelativePath} could not be read, so the next round is not told why round ${failure.round + 1} was rejected: ${toErrorMessage(read.failure)}`,
        };
      }
      excerpts.push(read.success.replace(/\n$/, ''));
    }
    return {
      kind: 'context',
      text:
        failures.length === 0
          ? undefined
          : formatCompileFailureRoundContext(
              failures,
              combineFailureLogExcerpts(excerpts),
            ),
    };
  },
);
