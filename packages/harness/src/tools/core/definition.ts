// Type imports
import { Cause, Effect, type Scope } from 'effect';
import { z, ZodError, type ZodType } from 'zod';
import type {
  HostToolCapability,
  ITool,
  ToolGuard,
} from '@agent/core/tools/ToolTypes';
import type { SettingHost } from '@shared/state/stateSettings';
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatZodIssuesForDiagnostics,
  ToolError,
  type ToolDefinition,
  type ToolResult,
} from '@shared/schemas';
import { findStorageRefusal } from '@shared/session/runHistory';
import { ensureError, toErrorMessage } from '@utils/errors/errorMessage';

// Third-party imports

/** The run body a tool definition carries. */
type ToolExecute<T, R> = (input: T) => Effect.Effect<ToolResult, Error, R>;

/**
 * A defined tool: plain data plus a `call` that validates and normalizes
 * failures. An anonymous object type so the SDK's `.d.ts` inlines it.
 */
export type DefinedTool<T, R = never> = Omit<ITool<Error, R>, 'call'> & {
  call(
    rawInput: unknown,
  ): Effect.Effect<ToolResult, Error, Exclude<R, Scope.Scope>>;
  readonly lane: ITool['lane'];
  readonly replay: ITool['replay'];
  readonly requiresApproval: ITool['requiresApproval'];
  readonly slow: boolean | undefined;
  readonly unavailableHosts: readonly SettingHost[] | undefined;
  readonly hostCapability: HostToolCapability | undefined;
  readonly guard: ToolGuard<T, R> | undefined;
  readonly describe: ITool['describe'];
};

export type DefineToolOptions<T, R = never> = Required<
  Pick<ToolDefinition, 'name' | 'description'>
> &
  Pick<ToolDefinition, 'scriptReturns'> &
  Pick<
    ITool,
    | 'unavailableHosts'
    | 'hostCapability'
    | 'lane'
    | 'scriptGlobal'
    | 'replay'
    | 'requiresApproval'
    | 'slow'
    | 'describe'
  > & {
    schema: ZodType<T, unknown>;
    /**
     * What the run loop checks before this tool's body runs: the paths the
     * call writes and the command it must get approved. Declared here,
     * applied once in `agent/runtime/loop/toolGuard.ts`.
     *
     * `NoInfer<R>`: the guard is checked against the requirement channel the
     * tool already has, it never sets it.
     */
    guard?: ToolGuard<T, NoInfer<R>>;
    execute: ToolExecute<T, R>;
  };

/**
 * Define a tool: validate the model's input against `schema`, run `execute`,
 * and turn ordinary failures into `{ status: 'error' }` feedback.
 * Interruption, run history refusals and database write failures propagate.
 */
export function defineTool<T, R = never>(
  def: DefineToolOptions<T, R>,
): DefinedTool<T, R> {
  const validate = (rawInput: unknown) =>
    Effect.try({
      try: () => def.schema.parse(rawInput),
      catch: ensureError,
    }).pipe(
      Effect.catch((error) =>
        error instanceof z.core.$ZodAsyncError
          ? Effect.tryPromise({
              try: () => def.schema.parseAsync(rawInput),
              catch: ensureError,
            })
          : Effect.fail(error),
      ),
    );
  return {
    definition: {
      name: def.name,
      description: def.description,
      // The Zod schema is the tool's only parameter representation; the
      // provider converters derive JSON Schema from it per request.
      zodSchema: def.schema,
      ...(def.scriptReturns !== undefined && {
        scriptReturns: def.scriptReturns,
      }),
    },
    lane: def.lane,
    ...(def.scriptGlobal !== undefined && { scriptGlobal: def.scriptGlobal }),
    replay: def.replay,
    requiresApproval: def.requiresApproval,
    slow: def.slow,
    unavailableHosts: def.unavailableHosts,
    hostCapability: def.hostCapability,
    guard: def.guard,
    describe: def.describe,
    // Validate lazily in the caller's fiber; interruption never becomes a
    // tool result.
    call: (rawInput) =>
      Effect.scoped(
        validate(rawInput).pipe(
          Effect.flatMap(def.execute),
          Effect.catchCause((cause) => {
            if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
            if (findStorageRefusal(cause)) return Effect.failCause(cause);
            const error = Cause.squash(cause);
            if (error instanceof ZodError) {
              return Effect.succeed<ToolResult>({
                status: 'error',
                error: `Invalid input:\n${z.prettifyError(error)}`,
                diagnostics: {
                  type: DIAGNOSTIC_TYPE_VALIDATION_ERROR,
                  formatted: formatZodIssuesForDiagnostics(error.issues),
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
