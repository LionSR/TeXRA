// Third-party imports
import { z, ZodError } from 'zod';

// Local imports - tools
import type { ToolDefinition } from '@model';
import { ToolResult, toolResult } from '@tools/result';

export abstract class BaseTool<T> {
  readonly definition: ToolDefinition;
  readonly schema: z.ZodSchema<T>;

  protected constructor(definition: ToolDefinition, schema: z.ZodSchema<T>) {
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
   * - ToolError or other Error: Returns error result with name and stack trace
   * - Other thrown values: Returns error result with string representation
   */
  async call(rawInput: unknown): Promise<ToolResult> {
    try {
      const input = this.validate(rawInput);
      return await this.execute(input);
    } catch (err) {
      if (err instanceof ZodError) {
        return toolResult({
          error: 'Invalid input',
          isError: true,
          diagnostics: err.issues,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      const diagnostics =
        err instanceof Error ? { name: err.name, stack: err.stack } : undefined;
      return toolResult({
        error: message,
        isError: true,
        diagnostics,
      });
    }
  }

  protected abstract execute(input: T): Promise<ToolResult>;
}
