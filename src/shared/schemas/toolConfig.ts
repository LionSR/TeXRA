/**
 * Tool configuration schema - shared between AgentConfig and MainViewPersistedState.
 */
import { z } from 'zod';

export const DEFAULT_TOOL_CONFIG = {
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  attachDiagnostics: false,
  autoCompileInputPdf: false,
} as const;

type ToolConfigField = keyof typeof DEFAULT_TOOL_CONFIG;

const ToolConfigBooleanFieldsShape = Object.fromEntries(
  Object.keys(DEFAULT_TOOL_CONFIG).map((key) => [key, z.boolean()]),
) as Record<ToolConfigField, z.ZodBoolean>;

export const ToolConfigInputFieldsSchema = z.object(
  ToolConfigBooleanFieldsShape,
);

const ToolConfigPrefaultFieldsShape = Object.fromEntries(
  Object.entries(ToolConfigBooleanFieldsShape).map(([key, schema]) => [
    key,
    schema.prefault(DEFAULT_TOOL_CONFIG[key as ToolConfigField]),
  ]),
) as { [K in ToolConfigField]: z.ZodPrefault<z.ZodBoolean> };

/**
 * Base tool config object schema (exposes .shape for composition).
 * Field-level prefaults handle partial inputs.
 */
export const ToolConfigFieldsSchema = z.object(ToolConfigPrefaultFieldsShape);

/**
 * Tool config schema with object-level prefault for standalone use.
 * Use ToolConfigFieldsSchema.shape for composition with other schemas.
 */
export const ToolConfigSchema =
  ToolConfigFieldsSchema.prefault(DEFAULT_TOOL_CONFIG);

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
