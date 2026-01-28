import { z } from 'zod';

import { ToolDefinitionSchema } from '@model';

export const AgentSource = z.enum([
  'custom',
  'builtIn',
  'builtInToolUse',
  'remote',
]);
export type AgentSource = z.infer<typeof AgentSource>;

/** Workflow: fixed-round document processing. ToolUse: interactive tool-calling. */
export enum AgentCategory {
  Workflow = 'workflow',
  ToolUse = 'toolUse',
}

export const AgentSettingBaseSchema = z.strictObject({
  documentTag: z
    .string()
    .min(1, 'documentTag cannot be empty')
    .prefault('document'),
  endTag: z.string().prefault('</latex_document>'),
  temperature: z.number().min(0).max(1).nullable().prefault(0.0),
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
});

/** Internal schema for XML structure mode - not exported. */
const XmlStructureMode = z.enum(['never', 'scratchpadOnly', 'always']);

export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.Workflow)
    .prefault(AgentCategory.Workflow),
  isRewrite: z.boolean().prefault(true),
  rounds: z.number().prefault(2),
  prefills: z.array(z.string()).prefault([]),
  outputExt: z.string().prefault('txt'),
  isMultipleOutput: z.boolean().prefault(false),
  xmlStructureMode: XmlStructureMode.optional(),
});

export const AgentToolUseSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.ToolUse)
    .prefault(AgentCategory.ToolUse),
});

/** Normalize input to ensure agentCategory discriminator is present (migrates legacy fields). */
function normalizeAgentSettingInput(input: unknown): unknown {
  if (typeof input !== 'object' || input === null) {
    return input;
  }
  const { agentType, maxRounds, ...rest } = input as Record<string, unknown>;

  // Migrate legacy maxRounds → rounds
  if (maxRounds !== undefined && rest.rounds === undefined) {
    rest.rounds = maxRounds;
  }

  // Already has agentCategory - just strip legacy agentType if present
  if (rest.agentCategory !== undefined) {
    return rest;
  }

  // Migrate legacy agentType → agentCategory
  const category =
    agentType === 'toolUse' ? AgentCategory.ToolUse : AgentCategory.Workflow;
  return { ...rest, agentCategory: category };
}

export const AgentSettingSchema = z.preprocess(
  normalizeAgentSettingInput,
  z.discriminatedUnion('agentCategory', [
    AgentWorkflowSettingSchema,
    AgentToolUseSettingSchema,
  ]),
);

export type AgentSetting = z.infer<typeof AgentSettingSchema>;
export type AgentWorkflowSetting = Extract<
  AgentSetting,
  { agentCategory: AgentCategory.Workflow }
>;
export type AgentToolUseSetting = Extract<
  AgentSetting,
  { agentCategory: AgentCategory.ToolUse }
>;

export function isWorkflowSetting(
  setting: AgentSetting,
): setting is AgentWorkflowSetting {
  return setting.agentCategory === AgentCategory.Workflow;
}

export function requireWorkflowSetting(
  setting: AgentSetting,
): AgentWorkflowSetting {
  if (!isWorkflowSetting(setting)) {
    throw new Error(
      'Expected workflow agent settings but received tool-use settings.',
    );
  }
  return setting;
}

export function hasEndTag(
  settings: AgentSetting,
  fileContent: string,
): boolean {
  if (settings.endTag && fileContent.includes(settings.endTag)) {
    return true;
  }
  return (
    settings.documentTag !== '' &&
    fileContent.includes(`</${settings.documentTag}>`)
  );
}

export const AgentPromptSchema = z.strictObject({
  systemPrompt: z.string().prefault(''),
  userPrefix: z.string().prefault(''),
  userRequest: z.union([z.string(), z.array(z.string())]).prefault(''),
  userReflect: z.string().optional(),
});

export type AgentPrompt = z.infer<typeof AgentPromptSchema>;

export const AgentDefinitionSchema = z.strictObject({
  name: z.string().trim().min(1),
  description: z.string().optional(),
  inherits: z.string().optional(),
  settings: z.record(z.string(), z.unknown()).prefault({}),
  prompts: z.record(z.string(), z.unknown()).prefault({}),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;
