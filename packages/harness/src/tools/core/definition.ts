// Third-party imports
import { Cause, Effect, Schema, type Scope } from 'effect';

// Local imports
import type { ITool, ToolGuard } from '@agent/core/tools/ToolTypes';
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatIssuesForDiagnostics,
  ToolError,
  type ToolDefinition,
  type ToolResult,
} from '@shared/schemas';
import { findStorageRefusal } from '@shared/session/runHistory';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * A defined tool: plain data plus a `call` that validates and normalizes
 * failures. An anonymous object type so the SDK's `.d.ts` inlines it.
 */
export type DefinedTool<T, R = never> = Omit<
  ITool<Error, R>,
  'call' | 'guard'
> & {
  call(
    rawInput: unknown,
  ): Effect.Effect<ToolResult, Error, Exclude<R, Scope.Scope>>;
  readonly guard?: ToolGuard<T, R>;
};

export type DefineToolOptions<T, R = never> = Required<
  Pick<ToolDefinition, 'name' | 'description'>
> &
  Pick<ToolDefinition, 'scriptReturns' | 'card'> &
  Pick<
    ITool,
    | 'unavailableHosts'
    | 'hostCapability'
    | 'launchesTasks'
    | 'lane'
    | 'scriptGlobal'
    | 'replay'
    | 'requiresApproval'
    | 'slow'
    | 'describe'
  > & {
    /** Decodes the model's input into `T`. */
    schema: Schema.Codec<T, unknown>;
    /**
     * What the run loop checks before this tool's body runs: the paths the
     * call writes and the command it must get approved. Declared here,
     * applied once in `agent/runtime/loop/toolGuard.ts`.
     *
     * `NoInfer<R>`: the guard is checked against the requirement channel the
     * tool already has, it never sets it.
     */
    guard?: ToolGuard<T, NoInfer<R>>;
    /** The run body. Succeed with the text the model reads back, or with a
     *  whole `ToolResult` for a summary, attachments or facts; fail with
     *  an `Error` and the model reads its message as the tool's error. */
    execute: (input: T) => Effect.Effect<ToolResult | string, Error, R>;
  };

/**
 * Define a tool: validate the model's input against `schema`, run `execute`,
 * and turn ordinary failures into `{ status: 'error' }` feedback.
 * Interruption, run history refusals and database write failures propagate.
 */
export function defineTool<T, R = never>(
  def: DefineToolOptions<T, R>,
): DefinedTool<T, R> {
  const {
    name,
    description,
    scriptReturns,
    card,
    schema,
    execute,
    ...declared
  } = def;
  // Every issue, not the first: the model corrects its call in one go.
  const decode = Schema.decodeUnknownEffect(schema);
  const validate = (rawInput: unknown) => decode(rawInput, { errors: 'all' });
  return {
    // First, so a caller's stray `definition` or `call` cannot replace the
    // ones built here.
    ...declared,
    definition: {
      name,
      description,
      // The schema is the tool's only parameter representation; the
      // provider converters derive JSON Schema from it per request.
      schema,
      ...(scriptReturns !== undefined && { scriptReturns }),
      ...(card !== undefined && { card }),
    },
    // Validate lazily in the caller's fiber; interruption never becomes a
    // tool result.
    call: (rawInput) =>
      Effect.scoped(
        validate(rawInput).pipe(
          Effect.flatMap(execute),
          Effect.map((result) =>
            typeof result === 'string' ? executed(result) : result,
          ),
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
            if (findStorageRefusal(cause)) return Effect.failCause(cause);
            const error = Cause.squash(cause);
            if (error instanceof Schema.SchemaError) {
              return Effect.succeed<ToolResult>({
                status: 'error',
                error: `Invalid input:\n${error.message}`,
                diagnostics: {
                  type: DIAGNOSTIC_TYPE_VALIDATION_ERROR,
                  formatted: formatIssuesForDiagnostics(error),
                },
              });
            }
            return Effect.succeed<ToolResult>({
              status: 'error',
              error: toErrorMessage(error).trim() || 'Tool execution failed.',
              ...(error instanceof ToolError &&
                error.summary !== undefined && { summary: error.summary }),
              ...(error instanceof Error && {
                diagnostics: { name: error.name },
              }),
            });
          }),
        ),
      ),
  };
}
