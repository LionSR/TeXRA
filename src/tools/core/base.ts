// Third-party imports
import { z, ZodError, type ZodType } from 'zod';

// Local imports - core tool types (single source of truth)
import type { ITool } from '@agent/core/tools/ToolTypes';
import { toErrorMessage } from '@common/errors';
import type { ToolDefinition } from '@model/ToolDefinition';
import {
  DIAGNOSTIC_TYPE_VALIDATION_ERROR,
  formatZodIssuesForDiagnostics,
  toolError,
  type ToolResult,
} from '@shared/schemas/toolResult';

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

  validate(input: unknown): T {
    return this.schema.parse(input);
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
      const input = this.validate(rawInput);
      // await is required here - without it, rejections bypass the catch block
      return await this.execute(input);
    } catch (err) {
      if (err instanceof ZodError) {
        return toolError(`Invalid input:\n${z.prettifyError(err)}`, {
          type: DIAGNOSTIC_TYPE_VALIDATION_ERROR,
          issues: err.issues,
          formatted: formatZodIssuesForDiagnostics(err.issues),
        });
      }
      const message = toErrorMessage(err);
      // Only include error name - stack traces waste tokens and aren't actionable by models
      const diagnostics = err instanceof Error ? { name: err.name } : undefined;
      return toolError(message, diagnostics);
    }
  }

  protected abstract execute(input: T): Promise<ToolResult>;
}
