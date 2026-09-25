import { z } from 'zod';

import {
  AgentCategory,
  AgentCategorySchema,
  AgentNameSchema,
  ToolDefinitionSchema,
  type ToolDefinition,
} from '@shared/schemas';

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
/**
 * Tool reference: a YAML name, parsed here into the bare `{ name }` entry
 * whose contract (description, parameters) the registry applies once per run
 * in `resolveAgentTools`; or, for definitions registered as values rather
 * than YAML, a whole tool definition, which may carry runtime-only fields no
 * YAML can express.
 */
const toolsField = z.array(
  z.union([
    z.string().transform((name): ToolDefinition => ({ name })),
    ToolDefinitionSchema,
  ]),
);

const AgentSettingBaseSchema = z.strictObject({
  temperature: temperatureField.prefault(1.0),
  requiredFilesInternal: requiredFilesField.prefault({}),
  defaultOutputFiles: defaultOutputFilesField.prefault([]),
  tools: toolsField.prefault([]),
});

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
// Input-friendly settings schemas: raw YAML values before inheritance and
// defaults. A string tool name is already parsed into its `{ name }` entry.
// ---------------------------------------------------------------------------

const rawAgentSettingBaseFields = {
  temperature: temperatureField.optional(),
  requiredFilesInternal: requiredFilesField.optional(),
  defaultOutputFiles: defaultOutputFilesField.optional(),
  tools: toolsField.optional(),
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
