import { toErrorMessage } from '@common/errors/errorMessage';

export function isCliFetchStackLog(args: readonly unknown[]): boolean {
  const [first] = args;
  if (!(first instanceof Error)) return false;
  const cause = first.cause;
  const causeMessage = cause instanceof Error ? cause.message : '';
  return (
    /fetch failed/i.test(first.message) &&
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ETIMEDOUT|getaddrinfo|remote\.texra\.ai/i.test(
      causeMessage,
    )
  );
}

export async function suppressCliFetchStackLogs<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    if (isCliFetchStackLog(args)) return;
    originalError(...args);
  };
  try {
    return await operation();
  } finally {
    console.error = originalError;
  }
}

export function formatCliModelListError(error: unknown): string {
  const message = toErrorMessage(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : undefined;
  const detail = causeMessage ?? message;
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|fetch failed/i.test(detail)) {
    return `texra: could not fetch model access metadata from remote.texra.ai: ${detail}`;
  }
  return `texra: could not list models: ${message}`;
}
