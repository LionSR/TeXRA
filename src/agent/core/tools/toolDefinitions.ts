/**
 * The package's uniform tool definitions, built from a run's resolved tool
 * list. Lives in `core` so the tool catalog can digest definitions without
 * reaching into the run runtime.
 */
import { JsonObjectSchema, type TurnRequest } from '@texra-ai/llm';

import type { ToolDefinition } from '@shared/schemas';

import { convertToolSchema } from './toolSchema';

type ToolDefinitions = NonNullable<TurnRequest['tools']>;

/** The package's uniform tool definitions for the run's resolved tool list. */
export function toolDefinitionsFor(
  definitions: readonly ToolDefinition[],
): ToolDefinitions {
  return definitions.map((definition) => ({
    name: definition.name,
    description: definition.description ?? '',
    parameters: JsonObjectSchema.parse(
      convertToolSchema(definition) ?? { type: 'object', properties: {} },
    ),
  }));
}
