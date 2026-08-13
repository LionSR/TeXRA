import type { CompileResult } from '@shared/schemas';

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
    ? [trimmedRequest, compileFailureContext].join('\n\n')
    : compileFailureContext;
}
