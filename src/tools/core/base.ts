// Third-party imports
import { z } from 'zod';

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
    const input = this.validate(rawInput);
    return this.execute(input);
  }

  protected abstract execute(input: T): Promise<ToolResult>;
}
