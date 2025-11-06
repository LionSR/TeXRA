import { toJSONSchema, type ZodType } from 'zod';
import type { ToolDefinition } from '@model';
import { BaseTool } from './base';

export function defineTool<T>(def: {
  name: string;
  description: string;
  schema: ZodType<T>;
}) {
  const baseDefinition: ToolDefinition = {
    name: def.name,
    description: def.description,
    parameters: toJSONSchema(def.schema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
      io: 'input',
    }) as Record<string, unknown>,
  };

  abstract class GeneratedTool extends BaseTool<T> {
    constructor(override?: Partial<ToolDefinition>) {
      super({ ...baseDefinition, ...override }, def.schema);
    }
  }

  return GeneratedTool;
}
