// Third-party imports
import { z, ZodError } from 'zod';

// Local imports - tools
import type { ToolDefinition } from '@model';
import { ToolResult } from '@tools/result';

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

  async call(rawInput: unknown): Promise<ToolResult> {
    try {
      const input = this.validate(rawInput);
      return await this.execute(input);
    } catch (err) {
      if (err instanceof ZodError) {
        return new ToolResult({
          error: 'Invalid input',
          isError: true,
          diagnostics: err.issues,
        });
      }
      const message = err instanceof Error ? err.message : String(err);
      const diagnostics =
        err instanceof Error ? { name: err.name, stack: err.stack } : undefined;
      return new ToolResult({
        error: message,
        isError: true,
        diagnostics,
      });
    }
  }

  protected abstract execute(input: T): Promise<ToolResult>;
}
