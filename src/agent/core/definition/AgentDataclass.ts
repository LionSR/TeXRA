import { z } from 'zod';

import { ToolDefinitionSchema } from '@model';
import {
  AgentCategory,
  AgentCategorySchema,
  AgentNameSchema,
} from '@shared/schemas/agent';
import {
  OUTPUT_DOCUMENTS_TAG,
  OUTPUT_END_TAG,
} from '@shared/constants/outputProtocol';

export { AgentCategory };

/**
 * Field validators shared between `AgentSettingBaseSchema` (materialised
 * settings, defaults applied) and `RawAgentSettingInputSchema` below (raw
 * YAML input, defaults intentionally left unmaterialised so inheritance can
 * tell "not written" apart from "written as the default value"). Sharing the
 * validator here keeps constraints like temperature's bounds in one place;
 * only the prefault-vs-optional wrapper differs per schema, by design.
 */
const temperatureField = z.number().min(0).max(1);
/** Shared by both `requiredFiles` and `requiredFilesInternal` — same shape, distinct fields. */
const requiredFilesField = z.record(z.string(), z.string());
const defaultOutputFilesField = z.array(z.string());
const filePatternsContainEntryFields = {
  pattern: z.string(),
  varName: z.string(),
};

export const AgentSettingBaseSchema = z.strictObject({
  temperature: temperatureField.prefault(1.0),
  requiredFiles: requiredFilesField.prefault({}),
  requiredFilesInternal: requiredFilesField.prefault({}),
  defaultOutputFiles: defaultOutputFilesField.prefault([]),
  filePatternsContain: z
    .array(
      z.strictObject({
        ...filePatternsContainEntryFields,
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

/**
 * Drop obsolete settings accepted only for legacy YAML and persisted state.
 * `documentTag`/`endTag` used to configure the per-agent output container;
 * every bundled and custom agent has converged on the fixed
 * `<documents><document name="...">...</document></documents>` protocol (see
 * `@shared/constants/outputProtocol`). The fixed default legacy values are
 * silently ignored so old bundled/persisted copies do not pollute CLI stderr;
 * bespoke legacy tags still warn because they now get the standard container.
 */
function stripLegacySettingFields(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return input;
  }
  const {
    outputExt: _outputExt,
    prefills: _prefills,
    documentTag,
    endTag,
    ...rest
  } = input as Record<string, unknown>;
  const hasLegacyOutputTags = documentTag !== undefined || endTag !== undefined;
  const usesDefaultOutputTags =
    (documentTag === undefined || documentTag === OUTPUT_DOCUMENTS_TAG) &&
    (endTag === undefined || endTag === OUTPUT_END_TAG);
  if (hasLegacyOutputTags && !usesDefaultOutputTags) {
    // console.warn, not the structured trace logger: this module is a leaf
    // schema (`core/definition`, dependency-free by design — see
    // src/agent/core/README.md) and must not pull in the logger's transitive
    // `@shared/schemas` barrel just for one deprecation notice. Same pattern
    // as `src/shared/schemas/streamData.ts`'s `warnDroppedItem`.
    console.warn(
      '[AgentDataclass] settings.documentTag/endTag are no longer configurable — every agent emits the fixed <documents><document name="..."> container. Ignoring the value from this agent definition.',
    );
  }
  return rest;
}

export const AgentSettingSchema = z.preprocess(
  stripLegacySettingFields,
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
  temperature: temperatureField.optional(),
  requiredFiles: requiredFilesField.optional(),
  requiredFilesInternal: requiredFilesField.optional(),
  defaultOutputFiles: defaultOutputFilesField.optional(),
  filePatternsContain: z
    .array(
      z.strictObject({
        ...filePatternsContainEntryFields,
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
  stripLegacySettingFields,
  RawAgentSettingInputSchema,
);

export type AgentSettingInput = z.infer<typeof AgentSettingInputSchema>;

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
