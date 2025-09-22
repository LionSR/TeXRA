import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition } from '@model';
import { BaseTool } from './base';

export function defineTool<T>(def: {
  name: string;
  description: string;
  schema: z.ZodJSONSchema<T>;
}) {
  const baseDefinition: ToolDefinition = {
    name: def.name,
    description: def.description,
    parameters: zodToJsonSchema(def.schema),
  };

  abstract class GeneratedTool extends BaseTool<T> {
    constructor(override?: Partial<ToolDefinition>) {
      super({ ...baseDefinition, ...override }, def.schema);
    }
  }

  return GeneratedTool;
}
