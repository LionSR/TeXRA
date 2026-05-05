import { z } from 'zod';

import { ToolDefinitionSchema } from '@model';

// AgentSource: single source of truth is @shared/schemas/agent.
// Re-exported here for backward compatibility with backend consumers.
export { AgentSource } from '@shared/schemas/agent';

/** Workflow: fixed-round document processing. ToolUse: interactive tool-calling. */
export enum AgentCategory {
  Workflow = 'workflow',
  ToolUse = 'toolUse',
}

export const AgentSettingBaseSchema = z.strictObject({
  documentTag: z
    .string()
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

export const AgentWorkflowSettingSchema = AgentSettingBaseSchema.extend({
  agentCategory: z
    .literal(AgentCategory.Workflow)
    .prefault(AgentCategory.Workflow),
  isRewrite: z.boolean().prefault(true),
  rounds: z.number().prefault(2),
  prefills: z.array(z.string()).prefault([]),
  outputExt: z.string().prefault('txt'),
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
  const {
    agentType,
    maxRounds,
    xmlStructureMode: _xmlStructureMode,
    isMultipleOutput: _isMultipleOutput,
    ...rest
  } = input as Record<string, unknown>;

  // Migrate legacy maxRounds → rounds
  if (maxRounds !== undefined && rest.rounds === undefined) {
    rest.rounds = maxRounds;
  }

  // Derive endTag from documentTag when endTag is not explicitly set.
  // Mirror the same default as documentTag.prefault so legacy agents with a
  // custom documentTag (e.g. 'latex_document') get '</${documentTag}>' rather
  // than the unified default '</documents>'.
  if (rest.endTag === undefined) {
    const docTag =
      typeof rest.documentTag === 'string' && rest.documentTag.length > 0
        ? rest.documentTag
        : 'documents';
    rest.endTag = `</${docTag}>`;
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
  const endTag = settings.endTag;
  return endTag !== '' && fileContent.includes(endTag);
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
