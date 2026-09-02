/**
 * Tool configuration schema - shared between AgentConfig and MainViewPersistedState.
 */
import { z } from 'zod';

export const DEFAULT_TOOL_CONFIG = {
  autoExtractFigure: false,
  autoExtractTikzFigure: false,
  attachTeXCount: false,
  autoCompileInputPdf: false,
} as const;

type ToolConfigField = keyof typeof DEFAULT_TOOL_CONFIG;

export const ToolConfigInputFieldsSchema = z.object(
  Object.fromEntries(
    Object.keys(DEFAULT_TOOL_CONFIG).map((key) => [key, z.boolean()]),
  ) as Record<ToolConfigField, z.ZodBoolean>,
);

/**
 * Base tool config object schema (exposes .shape for composition).
 * Field-level prefaults handle partial inputs.
 */
export const ToolConfigFieldsSchema = z.object(
  Object.fromEntries(
    Object.entries(DEFAULT_TOOL_CONFIG).map(([key, defaultValue]) => [
      key,
      z.boolean().prefault(defaultValue),
    ]),
  ) as { [K in ToolConfigField]: z.ZodPrefault<z.ZodBoolean> },
);

/**
 * Tool config schema with object-level prefault for standalone use.
 * Use ToolConfigFieldsSchema.shape for composition with other schemas.
 */
export const ToolConfigSchema =
  ToolConfigFieldsSchema.prefault(DEFAULT_TOOL_CONFIG);

export type ToolConfig = z.infer<typeof ToolConfigSchema>;
