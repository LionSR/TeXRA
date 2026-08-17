// Third-party imports
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
export abstract class BaseTool<T> implements ITool {
  readonly definition: ToolDefinition;
  readonly schema: ZodType<T, T>;

  protected constructor(definition: ToolDefinition, schema: ZodType<T, T>) {
    this.definition = definition;
    this.schema = schema;
  }

  validate(input: unknown): T | Promise<T> {
    try {
      return this.schema.parse(input);
    } catch (error) {
      if (error instanceof z.core.$ZodAsyncError) {
        return this.schema.parseAsync(input);
      }
      throw error;
    }
  }

  /**
   * Execute the tool with centralized error handling.
   *
   * This method validates the input using Zod schema, executes the tool's
   * implementation, and wraps any errors in a ToolResult with diagnostic
   * information.
   *
   * @param rawInput - The raw input to validate and pass to the tool
   * @returns A ToolResult containing either the output or error information
   *
   * Error handling behavior:
   * - ZodError: Returns error result with validation issues in diagnostics
   * - ToolError or other Error: Returns error result with error name (stack traces excluded to save tokens)
   * - Other thrown values: Returns error result with string representation
   */
  async call(rawInput: unknown): Promise<ToolResult> {
    try {
      // Synchronous validation must stay synchronous: awaiting unconditionally
      // would defer execute() by a microtask, so a tool that dispatches a host
      // interaction before its first await would no longer do so in the
      // caller's synchronous turn.
      const validated = this.validate(rawInput);
      const input = validated instanceof Promise ? await validated : validated;
      // await is required here - without it, rejections bypass the catch block
      return await this.execute(input);
    } catch (err) {
      if (err instanceof ZodError) {
        return {
          status: 'error',
          error: `Invalid input:\n${z.prettifyError(err)}`,
          diagnostics: {
            type: DIAGNOSTIC_TYPE_VALIDATION_ERROR,
            issues: err.issues,
            formatted: formatZodIssuesForDiagnostics(err.issues),
          },
        };
      }
      const message = toErrorMessage(err).trim();
      // Only include error name - stack traces waste tokens and aren't actionable by models
      const diagnostics = err instanceof Error ? { name: err.name } : undefined;
      const summary = err instanceof ToolError ? err.summary : undefined;
      return {
        status: 'error',
        error: message || 'Tool execution failed.',
        ...(summary !== undefined ? { summary } : {}),
        ...(diagnostics !== undefined ? { diagnostics } : {}),
      };
    }
  }

  protected abstract execute(input: T): Promise<ToolResult>;
}
