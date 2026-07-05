import { z } from 'zod';

import { ToolDefinitionSchema } from '@model';
import {
  AgentCategory,
  AgentCategorySchema,
  AgentNameSchema,
} from '@shared/schemas/agent';
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
  const {
    outputExt: _outputExt,
    prefills: _prefills,
    ...rest
  } = input as Record<string, unknown>;
  return rest;
}

/**
 * Derive endTag from documentTag when none is set. `fallbackTag` supplies the
 * tag when documentTag is absent/blank; `null` leaves the input unchanged.
 */
function deriveEndTagFrom(input: unknown, fallbackTag: string | null): unknown {
  if (typeof input !== 'object' || input === null) return input;
  const obj = input as Record<string, unknown>;
  if (obj.endTag !== undefined) return obj;
  const docTag = isNonEmptyString(obj.documentTag)
    ? obj.documentTag.trim()
    : fallbackTag;
  if (docTag === null) return input;
  return { ...obj, endTag: `</${docTag}>` };
}

/** Derive endTag from documentTag when endTag is not explicitly set. */
function deriveEndTag(input: unknown): unknown {
  return deriveEndTagFrom(input, 'documents');
}

/** Preserve partial child blocks: derive only from explicitly written documentTag. */
function deriveExplicitEndTag(input: unknown): unknown {
  return deriveEndTagFrom(input, null);
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

/** Partial settings as they appear in YAML before inheritance and defaults. */
const RawAgentSettingInputSchema = z.strictObject({
  agentCategory: AgentCategorySchema.optional(),
  documentTag: z
    .string()
    .trim()
    .min(1, 'documentTag cannot be empty')
    .optional(),
  endTag: z.string().optional(),
  temperature: z.number().min(0).max(1).optional(),
  requiredFiles: z.record(z.string(), z.string()).optional(),
  requiredFilesInternal: z.record(z.string(), z.string()).optional(),
  defaultOutputFiles: z.array(z.string()).optional(),
  filePatternsContain: z
    .array(
      z.strictObject({
        pattern: z.string(),
        varName: z.string(),
        categories: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  tools: z.array(AgentToolInputSchema).optional(),
  internal: z.boolean().optional(),
  isRewrite: z.boolean().optional(),
  rounds: z.int().positive().optional(),
});

/**
 * Raw YAML settings. This schema validates field shapes without materialising
 * defaults, so inherited child blocks only override fields the author wrote.
 */
export const AgentSettingInputSchema = z.preprocess(
  (input) => deriveExplicitEndTag(stripLegacySettingFields(input)),
  RawAgentSettingInputSchema,
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

/** Partial prompts as they appear in YAML before inheritance and defaults. */
export const AgentPromptInputSchema = z.strictObject({
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
