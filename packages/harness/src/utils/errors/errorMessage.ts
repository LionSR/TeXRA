// Third-party imports
import { Cause, Predicate } from 'effect';

import { truncateWithEllipsis } from '@utils/text/stringUtils';

/**
 * What a failed Effect raised: a `Cause` read as the one error
 * `Cause.squash` picks (a typed failure before a defect before an
 * interruption), anything else as itself. Every reader of an `unknown`
 * failure below starts here, so a caller holding a `Cause` passes it as is.
 */
const raisedBy = (err: unknown): unknown =>
  Cause.isCause(err) ? Cause.squash(err) : err;

/** `err` followed by its `cause` chain, outermost first; a `Cause` reads as
 *  the error it raised; an
 *  `AggregateError`'s `errors` follow it before its cause, and an error
 *  whose `reason` carries the cause (a `PlatformError`, a `SqlError`) is
 *  followed by that cause. Shared traversal for messages and for
 *  predicates whose fact may sit at any depth of a wrapped error. */
export function causeChain(err: unknown): unknown[] {
  // Ad-hoc wrapping can produce circular causes (err.cause === err); guard so
  // a lookup in an error path cannot itself hang the process.
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (current: unknown): void => {
    if (!Predicate.isObjectOrArray(current) || seen.has(current)) return;
    seen.add(current);
    chain.push(current);
    if (current instanceof AggregateError)
      for (const error of current.errors) visit(error);
    if ('cause' in current) visit(current.cause);
    if (
      'reason' in current &&
      Predicate.isObjectOrArray(current.reason) &&
      'cause' in current.reason
    )
      visit(current.reason.cause);
  };
  visit(raisedBy(err));
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
  if (nodes.length === 0) return String(raisedBy(err));
  const messages = nodes
    .map((node) => (node instanceof Error ? node.message : String(node)))
    .filter((message) => message.trim() !== '');
  // A message another one embeds adds nothing; of two equal ones the first
  // stays. Judged against the whole chain, so what is kept is final.
  const parts = messages.filter(
    (message, i) =>
      !messages.some(
        (other, j) =>
          j !== i && other.includes(message) && (other !== message || j < i),
      ),
  );
  // A sentence ends where the next part explains it, not with its own stop
  // (one stop: an ellipsis stays).
  return parts
    .map((part, i) =>
      i < parts.length - 1 ? part.replace(/(?<![.:])[.:]$/, '') : part,
    )
    .join(': ');
}

const MAX_ERROR_LENGTH = 500;

/** Format an error with a prefix for logging or user messages. */
export function formatError(prefix: string, err: unknown): string {
  const detail = truncateWithEllipsis(toErrorMessage(err), MAX_ERROR_LENGTH);
  return `${prefix}: ${detail}`;
}

/** Coerce any thrown value, or the `Cause` of a failed Effect, to an Error
 *  instance. */
export function ensureError(err: unknown): Error {
  const raised = raisedBy(err);
  return raised instanceof Error ? raised : new Error(toErrorMessage(raised));
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
