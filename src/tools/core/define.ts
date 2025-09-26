import { z } from 'zod';
import type { ToolDefinition } from '@model';
import { BaseTool } from './base';

export function defineTool<T>(def: {
  name: string;
  description: string;
  schema: z.ZodSchema<T>;
}) {
  const baseDefinition: ToolDefinition = {
    name: def.name,
    description: def.description,
    parameters: z.toJSONSchema(def.schema),
  };

  abstract class GeneratedTool extends BaseTool<T> {
    constructor(override?: Partial<ToolDefinition>) {
      super({ ...baseDefinition, ...override }, def.schema);
    }
  }

  return GeneratedTool;
}
