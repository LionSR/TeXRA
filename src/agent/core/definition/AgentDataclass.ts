import { z } from 'zod';

import { ToolDefinitionSchema } from '@model/ToolDefinition';
import {
  AgentCategory,
  AgentCategorySchema,
  AgentNameSchema,
} from '@shared/schemas/agent';
import { OUTPUT_END_TAG } from '@shared/schemas/output';

/**
 * Field validators shared between `AgentSettingBaseSchema` (materialised
 * settings, defaults applied) and `AgentSettingInputSchema` below (raw
 * YAML input, defaults intentionally left unmaterialised so inheritance can
 * tell "not written" apart from "written as the default value"). Sharing the
 * validator here keeps constraints like temperature's bounds in one place;
 * only the prefault-vs-optional wrapper differs per schema, by design.
 */
const temperatureField = z.number().min(0).max(1);
/** Variable name to file path, resolved against the agent's YAML directory. */
const requiredFilesField = z.record(z.string(), z.string());
const defaultOutputFilesField = z.array(z.string());

const AgentSettingBaseSchema = z.strictObject({
  temperature: temperatureField.prefault(1.0),
  requiredFilesInternal: requiredFilesField.prefault({}),
  defaultOutputFiles: defaultOutputFilesField.prefault([]),
  tools: z.array(ToolDefinitionSchema).prefault([]),
});

/**
 * Tool reference: a name resolved from the registry, or — for definitions
 * registered as values rather than YAML — a whole tool definition, which may
 * carry runtime-only fields no YAML can express.
 */
const AgentToolInputSchema = z.union([z.string(), ToolDefinitionSchema]);

export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.Workflow)
    .prefault(AgentCategory.Workflow),
  isRewrite: z.boolean().prefault(true),
  rounds: z.int().positive().prefault(2),
});

export const AgentToolUseSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.ToolUse)
    .prefault(AgentCategory.ToolUse),
});

export const AgentSettingSchema = z.discriminatedUnion('agentCategory', [
  AgentWorkflowSettingSchema,
  AgentToolUseSettingSchema,
]);

export type AgentSetting = z.infer<typeof AgentSettingSchema>;
export type AgentWorkflowSetting = Extract<
  AgentSetting,
  { agentCategory: typeof AgentCategory.Workflow }
>;
export type AgentToolUseSetting = Extract<
  AgentSetting,
  { agentCategory: typeof AgentCategory.ToolUse }
>;

// ---------------------------------------------------------------------------
// Input-friendly settings schemas — accept raw YAML values (string tool names)
// before the tool-resolution step replaces them with full ToolDefinition objects.
// ---------------------------------------------------------------------------

const rawAgentSettingBaseFields = {
  temperature: temperatureField.optional(),
  requiredFilesInternal: requiredFilesField.optional(),
  defaultOutputFiles: defaultOutputFilesField.optional(),
  tools: z.array(AgentToolInputSchema).optional(),
};

/** Workflow-only settings, shared by the partial and root raw input schemas. */
const rawWorkflowSettingFields = {
  isRewrite: z.boolean().optional(),
  rounds: z.int().positive().optional(),
};

/** Partial settings as they appear in YAML before inheritance and defaults. */
const AgentSettingInputSchema = z.strictObject({
  ...rawAgentSettingBaseFields,
  ...rawWorkflowSettingFields,
  agentCategory: AgentCategorySchema.optional(),
});

export type AgentSettingInput = z.infer<typeof AgentSettingInputSchema>;

/**
 * Complete root settings before tool-name resolution. Unlike inherited partial
 * settings, the category is known here, so category-specific fields can be
 * checked without importing the tool registry.
 */
export const AgentRootSettingInputSchema = z.discriminatedUnion(
  'agentCategory',
  [
    z.strictObject({
      ...rawAgentSettingBaseFields,
      ...rawWorkflowSettingFields,
      agentCategory: z.literal(AgentCategory.Workflow),
    }),
    z.strictObject({
      ...rawAgentSettingBaseFields,
      agentCategory: z.literal(AgentCategory.ToolUse),
    }),
  ],
);

/** Whether `fileContent` already contains the protocol's closing tag. */
export function hasEndTag(fileContent: string): boolean {
  return fileContent.includes(OUTPUT_END_TAG);
}

export const AgentPromptSchema = z.strictObject({
  systemPrompt: z.string().prefault(''),
  userPrefix: z.string().prefault(''),
  userRequest: z.union([z.string(), z.array(z.string())]).prefault(''),
});

export type AgentPrompt = z.infer<typeof AgentPromptSchema>;

/** Partial prompts as they appear in YAML before inheritance and defaults. */
const AgentPromptInputSchema = z.strictObject({
  systemPrompt: z.string().optional(),
  userPrefix: z.string().optional(),
  userRequest: z.union([z.string(), z.array(z.string())]).optional(),
});

export type AgentPromptInput = z.infer<typeof AgentPromptInputSchema>;

export const AgentDefinitionSchema = z.strictObject({
  name: AgentNameSchema,
  description: z.string().optional(),
  inherits: z.string().optional(),
  settings: AgentSettingInputSchema.prefault({}),
  prompts: AgentPromptInputSchema.prefault({}),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
