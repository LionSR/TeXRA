/**
 * Common result schemas used across utilities.
 */
// Third-party imports
import { Schema } from 'effect';

const ExecResultSchema = Schema.Struct({
  /** Indicates whether the command succeeded */
  success: Schema.Boolean,
  /**
   * Standard output from the command. Empty or whitespace-only output is
   * normalized to the empty string by execUtils.normalizeOutput.
   */
  stdout: Schema.String,
  /**
   * Standard error from the command. Empty or whitespace-only stderr is
   * normalized to the empty string, matching {@link ExecResult.stdout}.
   */
  stderr: Schema.String,
  /** True if the command timed out */
  timedOut: Schema.Boolean,
  /** Exit code from the command */
  exitCode: Schema.Int,
  /** True when subprocess output exceeded the configured retained-output limit. */
  outputLimitExceeded: Schema.optional(Schema.Boolean),
  /**
   * True when the command has no exit code of its own: it could not start,
   * died by a signal, or its output could not be read. `exitCode` then holds
   * the conventional code executeCommand reports for that outcome.
   */
  noExitCode: Schema.optional(Schema.Boolean),
});

/**
 * What running a shell command produced: whether it succeeded, its output
 * streams, its exit code and whether it timed out or overran the output limit.
 * `executeCommand` in `@utils/system/execUtils` returns it, and the bash tool
 * formats it for the model.
 */
export type ExecResult = typeof ExecResultSchema.Type;

/**
 * What closing a session settled, and what it did not: the answer of the
 * session owner's close (`Sessions.close`, the SDK's `closeSession`). New
 * executions were refused and the owned live ones interrupted; `settled`
 * says every one of them ended inside the close budget. Otherwise
 * `abandoned` names the executions still live when the budget ran out: the
 * session stays open, refusing new work, until they actually end, and the
 * caller must not treat the close as complete disposal.
 */
const SessionCloseReportSchema = Schema.Struct({
  settled: Schema.Boolean,
  abandoned: Schema.Array(Schema.String),
});

/**
 * The decoded shape of the close report: `settled` when every live execution
 * ended inside the close budget, otherwise the run ids still live in
 * `abandoned`.
 */
export type SessionCloseReport = typeof SessionCloseReportSchema.Type;
