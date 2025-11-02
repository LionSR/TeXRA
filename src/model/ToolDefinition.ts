// Third-party imports
import { z } from 'zod';
import type { Tool } from '@modelcontextprotocol/sdk/types';

const JsonSchemaObject = z
  .object({
    type: z.literal('object'),
    properties: z.record(z.string(), z.unknown()).optional(),
    required: z.array(z.string()).optional(),
    additionalProperties: z.boolean().optional(),
  })
  .passthrough();

const ToolAnnotationsSchema = z
  .object({
    title: z.string().optional(),
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
    singletonHint: z.boolean().optional(),
    parallelizableHint: z.boolean().optional(),
    progressSchema: JsonSchemaObject.optional(),
    documentation: z.string().optional(),
    legalHint: z.string().optional(),
    openWorldHint: z.boolean().optional(),
  })
  .passthrough();

const ToolDefinitionSchemaInternal = z
  .object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    inputSchema: JsonSchemaObject,
    outputSchema: JsonSchemaObject.optional(),
    annotations: ToolAnnotationsSchema.optional(),
  })
  .passthrough();

export const ToolDefinitionSchema =
  ToolDefinitionSchemaInternal as z.ZodType<Tool>;

/** Shared tool definition type aligned with the MCP SDK. */
export type ToolDefinition = Tool;
