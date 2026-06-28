import { z } from 'zod';

import { ToolDefinitionSchema } from '@model';
import { AgentCategory, AgentNameSchema } from '@shared/schemas/agent';
import { isNonEmptyString } from '@utils/core';

export { AgentCategory };

export const AgentSettingBaseSchema = z.strictObject({
  documentTag: z
    .string()
    .trim()
    .min(1, 'documentTag cannot be empty')
    .prefault('documents'),
  endTag: z.string().prefault('</documents>'),
  temperature: z.number().min(0).max(1).prefault(1.0),
  requiredFiles: z.record(z.string(), z.string()).prefault({}),
  requiredFilesInternal: z.record(z.string(), z.string()).prefault({}),
  defaultOutputFiles: z.array(z.string()).prefault([]),
  filePatternsContain: z
    .array(
      z.strictObject({
        pattern: z.string(),
        varName: z.string(),
        categories: z.array(z.string()).prefault([]),
      }),
    )
    .prefault([]),
  tools: z.array(ToolDefinitionSchema).prefault([]),
  /** Registry metadata: hides the agent from default launcher listings. */
  internal: z.boolean().optional(),
});

/** Tool reference that may be a raw name string (YAML) or a resolved definition. */
const AgentToolInputSchema = z.union([z.string(), ToolDefinitionSchema]);

export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.Workflow)
    .prefault(AgentCategory.Workflow),
  isRewrite: z.boolean().prefault(true),
  rounds: z.int().positive().prefault(2),
  prefills: z.array(z.string()).prefault([]),
});

export const AgentToolUseSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.ToolUse)
    .prefault(AgentCategory.ToolUse),
});

/** Drop obsolete settings accepted only for legacy YAML and persisted state. */
function stripLegacySettingFields(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const { outputExt: _outputExt, ...rest } = input as Record<string, unknown>;
  return rest;
}

/** Derive endTag from documentTag when endTag is not explicitly set. */
function deriveEndTag(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;
  if (obj.endTag !== undefined) return obj;
  const docTag = isNonEmptyString(obj.documentTag)
    ? obj.documentTag.trim()
    : 'documents';
  return { ...obj, endTag: `</${docTag}>` };
}

export const AgentSettingSchema = z.preprocess(
  (input) => deriveEndTag(stripLegacySettingFields(input)),
  z.discriminatedUnion('agentCategory', [
    AgentWorkflowSettingSchema,
    AgentToolUseSettingSchema,
  ]),
);

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

/** Base settings as they appear in YAML: tools may be raw name strings. */
const AgentSettingBaseInputSchema = AgentSettingBaseSchema.extend({
  tools: z.array(AgentToolInputSchema).prefault([]),
});

const AgentWorkflowSettingInputSchema = AgentWorkflowSettingSchema.extend({
  tools: z.array(AgentToolInputSchema).prefault([]),
});

const AgentToolUseSettingInputSchema = AgentToolUseSettingSchema.extend({
  tools: z.array(AgentToolInputSchema).prefault([]),
});

/** Discriminated union matching AgentSettingSchema but accepting raw tool names. */
export const AgentSettingInputSchema = z.preprocess(
  (input) => deriveEndTag(stripLegacySettingFields(input)),
  z.discriminatedUnion('agentCategory', [
    AgentWorkflowSettingInputSchema,
    AgentToolUseSettingInputSchema,
  ]),
);

export type AgentSettingInput = z.infer<typeof AgentSettingInputSchema>;

export function hasEndTag(
  settings: AgentSetting,
  fileContent: string,
): boolean {
  const endTag = settings.endTag;
  return endTag !== '' && fileContent.includes(endTag);
}

export const AgentPromptSchema = z.strictObject({
  systemPrompt: z.string().prefault(''),
  userPrefix: z.string().prefault(''),
  userRequest: z.union([z.string(), z.array(z.string())]).prefault(''),
});

export type AgentPrompt = z.infer<typeof AgentPromptSchema>;

export const AgentDefinitionSchema = z.strictObject({
  name: AgentNameSchema,
  description: z.string().optional(),
  inherits: z.string().optional(),
  settings: AgentSettingInputSchema,
  prompts: AgentPromptSchema,
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
