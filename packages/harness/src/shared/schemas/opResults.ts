/**
 * Common result schemas used across utilities.
 */
// Third-party imports
import { Schema } from 'effect';

/** How a command ended. */
export type ExecEnd =
  | { readonly _tag: 'Exited'; readonly code: number }
  | { readonly _tag: 'TimedOut' }
  | { readonly _tag: 'LimitExceeded'; readonly stream: 'stdout' | 'stderr' }
  /** It has no exit code of its own: it could not start, died by a signal,
   *  or its output could not be read. */
  | { readonly _tag: 'NoExit'; readonly why: 'spawn' | 'signal' | 'read' };

/** What `executeCommand` answers. */
export interface ExecResult {
  /** It exited with code 0. */
  readonly success: boolean;
  /** Empty or whitespace-only output is normalized to the empty string. */
  readonly stdout: string;
  /** Normalized as `stdout` is. */
  readonly stderr: string;
  readonly end: ExecEnd;
}

/**
 * What closing a session ended, and what it did not: the answer of the
 * session owner's close (`Sessions.close`, the SDK's `closeSession`). New
 * executions were refused and the owned live ones interrupted. `abandoned`
 * names the executions still live when the close budget ran out, empty when
 * every one ended inside it: the session stays open, refusing new work,
 * until they actually end, and the caller must not treat a close with
 * abandoned executions as complete disposal.
 */
const SessionCloseReportSchema = Schema.Struct({
  abandoned: Schema.Array(Schema.String),
});

export type SessionCloseReport = typeof SessionCloseReportSchema.Type;
