// Third-party imports
import { Cause, Effect, Result, Schema, type Scope } from 'effect';

// Local imports
import type { ITool, ToolCommand } from '@tools/core/ToolTypes';
import { logFailure } from '@logger/effectLog';
import {
  ToolError,
  type ToolCard,
  type ToolDefinition,
  type ToolResult,
} from '@shared/schemas';
import { findStorageRefusal } from '@shared/session/runHistory';
import { executed } from '@tools/core/result';
import { toErrorMessage } from '@utils/errors/errorMessage';

const CHANNEL = 'tools';

/**
 * A defined tool: plain data plus a `call` that validates and normalizes
 * failures. An anonymous object type so the SDK's `.d.ts` inlines it.
 */
export type DefinedTool<T, R = never, Name extends string = string> = Omit<
  ITool<Error, R>,
  'call' | 'command' | 'definition'
> & {
  readonly definition: ToolDefinition & { readonly name: Name };
  call(
    rawInput: unknown,
  ): Effect.Effect<ToolResult, Error, Exclude<R, Scope.Scope>>;
  readonly command?: ToolCommand<T>;
};

export type DefineToolOptions<T, R = never> = Required<
  Pick<ToolDefinition, 'name' | 'description'>
> &
  Pick<ToolDefinition, 'scriptReturns'> &
  Pick<
    ITool,
    | 'hostCapability'
    | 'lane'
    | 'scriptGlobal'
    | 'replay'
    | 'requiresApproval'
    | 'describe'
  > & {
    /** Decodes the model's input into `T`. */
    schema: Schema.Codec<T, unknown>;
    /** The command a call runs, which the run loop gets approved before
     *  the body; the body never asks again. */
    command?: ToolCommand<T>;
    /** The card a call states from its decoded input (`ToolUseLog.card`).
     *  A call whose input does not decode gets none. */
    card?: (input: T) => ToolCard | undefined;
    /** The run body. Succeed with the text the model reads back, or with a
     *  whole `ToolResult` for a summary, attachments or facts; fail with
     *  an `Error` and the model reads its message as the tool's error. */
    execute: (input: T) => Effect.Effect<ToolResult | string, Error, R>;
  };

/**
 * Define a tool: validate the model's input against `schema`, run `execute`,
 * and turn ordinary failures into `{ status: 'error' }` feedback.
 * Interruption, run history refusals and database write failures propagate.
 *
 * A tool whose `execute` succeeds with a `ToolResult` carrying a `value`
 * hands a script that value in place of `{ output, summary }`. Declare its
 * TypeScript type in `scriptReturns`, which is what a script is told the
 * call resolves to. Nothing derives one from the other: a tool that returns
 * a `value` without `scriptReturns` is declared to scripts as resolving to
 * `ToolOutput`, so change the two together.
 */
export function defineTool<T, R = never, const Name extends string = string>(
  def: DefineToolOptions<T, R> & { readonly name: Name },
): DefinedTool<T, R, Name> {
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
      ...(card !== undefined && {
        card: (rawInput: unknown) => {
          const input = Schema.decodeUnknownResult(schema)(rawInput);
          return Result.getOrUndefined(Result.map(input, card));
        },
      }),
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
              });
            }
            const result = Effect.succeed<ToolResult>({
              status: 'error',
              error: toErrorMessage(error).trim() || 'Tool execution failed.',
              ...(error instanceof ToolError &&
                error.summary !== undefined && { summary: error.summary }),
            });
            // A defect that is not the tool's own failure is a bug in the
            // tool: the model reads it as a failed call, so the log keeps
            // its cause, or nothing would.
            return Cause.hasDies(cause) && !(error instanceof ToolError)
              ? logFailure(
                  CHANNEL,
                  `Tool ${name} crashed: ${toErrorMessage(error)}`,
                )(error).pipe(Effect.andThen(result))
              : result;
          }),
        ),
      ),
  };
}
