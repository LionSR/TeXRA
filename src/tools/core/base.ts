// Third-party imports
import { Cause, Effect, type Scope } from 'effect';
import { z, ZodError, type ZodType } from 'zod';

// Local imports - core tool types (single source of truth)
import type { ITool } from '@agent/core/tools/ToolTypes';
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatZodIssuesForDiagnostics,
  ToolError,
  type ToolDefinition,
  type ToolResult,
} from '@shared/schemas';
import { DatabaseWriteFailed } from '@shared/session/database';
import { RunLedgerRefused } from '@shared/session/runLedger';
import { toErrorMessage } from '@utils/errors/errorMessage';

/**
 * Abstract base class for tool implementations.
 *
 * Implements the ITool interface and provides:
 * - Zod schema validation
 * - Centralized error handling with diagnostics
 * - Type-safe input parsing
 *
 * Subclasses must implement the execute() method.
 */
export abstract class BaseTool<T, R = never> implements ITool<unknown, R> {
  readonly definition: ToolDefinition;
  private readonly schema: ZodType<T, unknown>;

  protected constructor(
    definition: ToolDefinition,
    schema: ZodType<T, unknown>,
  ) {
    this.definition = definition;
    this.schema = schema;
  }

  /** Validate lazily in the caller's fiber; interruption never becomes a tool result. */
  call(
    rawInput: unknown,
  ): Effect.Effect<ToolResult, unknown, Exclude<R, Scope.Scope>> {
    const validate = Effect.try({
      try: () => this.schema.parse(rawInput),
      catch: (error) => error,
    }).pipe(
      Effect.catch((error) =>
        error instanceof z.core.$ZodAsyncError
          ? Effect.tryPromise({
              try: () => this.schema.parseAsync(rawInput),
              catch: (cause) => cause,
            })
          : Effect.fail(error),
      ),
    );
    return Effect.scoped(
      validate.pipe(
        Effect.flatMap((input) => this.execute(input)),
        Effect.catchCause((cause) => {
          if (Cause.hasInterrupts(cause)) return Effect.failCause(cause);
          const error = Cause.squash(cause);
          if (
            error instanceof DatabaseWriteFailed ||
            error instanceof RunLedgerRefused
          )
            return Effect.failCause(cause);
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
    );
  }

  protected abstract execute(input: T): Effect.Effect<ToolResult, unknown, R>;
}
