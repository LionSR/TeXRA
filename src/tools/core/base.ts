// Third-party imports
import { ZodError, type ZodType } from 'zod';

// Local imports - common

// Local imports - core tool types (single source of truth)
import type { ITool, ToolDefinition, ToolResult } from '@agent/core/ToolTypes';
import { toErrorMessage } from '@common/errors';

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
  readonly schema: ZodType<T>;

  protected constructor(definition: ToolDefinition, schema: ZodType<T>) {
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
      return await this.execute(input);
    } catch (err) {
      if (err instanceof ZodError) {
        // Include validation details in error message so model can self-correct
        const issues = err.issues
          .map((i) => `- ${i.path.join('.')}: ${i.message}`)
          .join('\n');
        return {
          error: `Invalid input:\n${issues}`,
          isError: true,
        };
      }
      const message = toErrorMessage(err);
      // Only include error name - stack traces waste tokens and aren't actionable by models
      const diagnostics = err instanceof Error ? { name: err.name } : undefined;
      return {
        error: message,
        isError: true,
        diagnostics,
      };
    }
  }

  protected abstract execute(input: T): Promise<ToolResult>;
}
