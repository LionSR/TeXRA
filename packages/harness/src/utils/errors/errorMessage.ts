import { truncateWithEllipsis } from '@utils/text/stringUtils';

/** `err` followed by its `cause` chain, outermost first; an
 *  `AggregateError`'s `errors` follow it before its cause. Shared traversal
 *  for messages and for predicates whose fact may sit at any depth of a
 *  wrapped error. */
export function causeChain(err: unknown): unknown[] {
  // Ad-hoc wrapping can produce circular causes (err.cause === err); guard so
  // a lookup in an error path cannot itself hang the process.
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (current: unknown): void => {
    if (current == null || typeof current !== 'object' || seen.has(current))
      return;
    seen.add(current);
    chain.push(current);
    if (current instanceof AggregateError)
      for (const error of current.errors) visit(error);
    visit((current as { cause?: unknown }).cause);
  };
  visit(err);
  return chain;
}

/**
 * Normalize any thrown value into a user-friendly error message string: the
 * error's own message, then the messages down its `cause` chain (and an
 * `AggregateError`'s members), each once, joined with `: `. A wrapper
 * whose sentence already embeds its cause's message adds nothing, and a
 * wrapper with a fixed sentence no longer hides the failure under it.
 */
export function toErrorMessage(err: unknown): string {
  const nodes = causeChain(err);
  if (nodes.length === 0) return String(err);
  const parts: string[] = [];
  for (const node of nodes) {
    const message = node instanceof Error ? node.message : String(node);
    if (message.trim() === '') continue;
    const index = parts.findIndex((part) => message.includes(part));
    if (parts.some((part) => part.includes(message))) continue;
    if (index === -1) parts.push(message);
    else parts[index] = message;
  }
  // A sentence ends where the next part explains it, not with its own stop.
  return parts
    .map((part, i) => (i < parts.length - 1 ? part.replace(/[.:]$/, '') : part))
    .join(': ');
}

const MAX_ERROR_LENGTH = 500;

/** Format an error with a prefix for logging or user messages. */
export function formatError(prefix: string, err: unknown): string {
  const detail = truncateWithEllipsis(toErrorMessage(err), MAX_ERROR_LENGTH);
  return `${prefix}: ${detail}`;
}

/** Coerce any thrown value to an Error instance. */
export function ensureError(err: unknown): Error {
  return err instanceof Error ? err : new Error(toErrorMessage(err));
}

/**
 * Extract error message from Error objects or strings.
 * Returns `undefined` if the value is neither an Error nor a non-empty string.
 *
 * Use this when you need optional extraction. For a guaranteed string, use
 * {@link toErrorMessage}.
 */
export function extractErrorMessage(err: unknown): string | undefined {
  if (err instanceof Error && err.message.trim() !== '') {
    return err.message.trim();
  }
  if (typeof err === 'string' && err.trim() !== '') {
    return err.trim();
  }
  return undefined;
}
