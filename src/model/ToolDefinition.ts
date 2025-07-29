// Third-party imports
import { z } from 'zod';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import type { Tool as AnthropicTool } from '@anthropic-ai/sdk/resources/messages/messages';
import type { Schema } from '@google/genai/dist/genai';

export type ParameterSchema =
  | ChatCompletionTool['function']['parameters']
  | AnthropicTool['input_schema']
  | Schema
  | Record<string, unknown>;

/** Zod schema describing a tool/function that a provider can execute. */
export const ToolDefinitionSchema: z.ZodType<{
  name: string;
  description?: string;
  parameters?: ParameterSchema;
}> = z
  .object({
    /** Name of the tool or function */
    name: z.string(),
    /** Optional description for the model */
    description: z.string().optional(),
    /** Parameter schema or provider specific metadata */
    parameters: z.record(z.unknown()).optional(),
  })
  .strict();

export type ToolDefinition = z.infer<typeof ToolDefinitionSchema>;
