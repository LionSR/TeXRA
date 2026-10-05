import type { core } from 'zod';

/** Zod conversion options shared by tool definitions and provider adapters. */
export const TOOL_JSON_SCHEMA_OPTIONS = Object.freeze({
  target: 'draft-2020-12',
  unrepresentable: 'any',
  io: 'input',
} as const satisfies core.ToJSONSchemaParams);
