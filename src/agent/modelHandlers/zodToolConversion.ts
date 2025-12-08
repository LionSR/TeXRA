/**
 * Zod-based tool conversion utilities for the Anthropic SDK.
 *
 * This module provides utilities for converting Zod schemas to Anthropic tool
 * definitions using the SDK's native `betaZodTool` helper. This enables direct
 * integration with the Anthropic SDK's tool runner for simpler use cases.
 *
 * @example
 * ```typescript
 * import { z } from 'zod';
 * import { createZodTool, createZodToolsForRunner } from './zodToolConversion';
 *
 * const weatherSchema = z.object({
 *   location: z.string().describe('The city and state'),
 * });
 *
 * // For use with client.beta.messages.toolRunner()
 * const zodTool = createZodTool({
 *   name: 'getWeather',
 *   description: 'Get the weather at a location',
 *   inputSchema: weatherSchema,
 *   run: async ({ location }) => `Weather in ${location}: sunny`,
 * });
 * ```
 */

// Third-party imports
import { type ZodType, type infer as zodInfer } from 'zod';
import { betaZodTool as sdkBetaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';

// Type imports
import type { ToolDefinition } from '@model';
import type {
  BetaRunnableTool,
  Promisable,
} from '@anthropic-ai/sdk/lib/tools/BetaRunnableTool';
import type { BetaToolResultContentBlockParam } from '@anthropic-ai/sdk/resources/beta';

/**
 * Options for creating a Zod-based tool.
 */
export interface ZodToolOptions<T extends ZodType> {
  /** Name of the tool */
  name: string;
  /** Description shown to the model */
  description: string;
  /** Zod schema for input validation */
  inputSchema: T;
  /** Function to execute when the tool is called */
  run: (
    args: zodInfer<T>,
  ) => Promisable<string | Array<BetaToolResultContentBlockParam>>;
}

/**
 * Creates an Anthropic-compatible tool from a Zod schema with a run function.
 *
 * This wraps the SDK's `betaZodTool` helper to create a tool that can be
 * used with `client.beta.messages.toolRunner()` for automatic tool execution.
 *
 * @param options Tool definition options including Zod schema and run function
 * @returns A BetaRunnableTool that can be passed to toolRunner()
 *
 * @example
 * ```typescript
 * const tool = createZodTool({
 *   name: 'calculator',
 *   description: 'Performs basic math',
 *   inputSchema: z.object({
 *     expression: z.string().describe('Math expression to evaluate'),
 *   }),
 *   run: ({ expression }) => String(eval(expression)),
 * });
 *
 * const response = await client.beta.messages.toolRunner({
 *   messages: [{ role: 'user', content: 'What is 2 + 2?' }],
 *   tools: [tool],
 *   model: 'claude-sonnet-4-20250514',
 *   max_tokens: 1024,
 * });
 * ```
 */
export function createZodTool<T extends ZodType>(
  options: ZodToolOptions<T>,
): BetaRunnableTool<zodInfer<T>> {
  return sdkBetaZodTool(options);
}

/**
 * Creates multiple Zod-based tools for use with the tool runner.
 *
 * @param tools Array of tool options
 * @returns Array of BetaRunnableTools
 */
export function createZodToolsForRunner<T extends ZodType>(
  tools: ZodToolOptions<T>[],
): BetaRunnableTool<zodInfer<T>>[] {
  return tools.map((tool) => createZodTool(tool));
}

/**
 * Type alias for a Zod tool that can be used with toolRunner().
 * Re-exported from the SDK for convenience.
 */
export type { BetaRunnableTool, Promisable };

/**
 * Converts a ToolDefinition (which may have been created from a Zod schema)
 * back to a format suitable for the standard messages API.
 *
 * Note: This loses the run function - use createZodTool for tools that need
 * automatic execution via toolRunner().
 */
export function zodToolToDefinition<T extends ZodType>(
  options: Omit<ZodToolOptions<T>, 'run'> & { run?: ZodToolOptions<T>['run'] },
): ToolDefinition {
  // Import toJSONSchema from zod for schema conversion
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { toJSONSchema } = require('zod');
  return {
    name: options.name,
    description: options.description,
    parameters: toJSONSchema(options.inputSchema, {
      target: 'draft-2020-12',
      unrepresentable: 'any',
      io: 'input',
    }) as Record<string, unknown>,
  };
}
