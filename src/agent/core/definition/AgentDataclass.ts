import { z } from 'zod';

import { ToolDefinitionSchema } from '@model';
import {
  AgentCategory,
  AgentCategorySchema,
  AgentNameSchema,
} from '@shared/schemas/agent';
import { OUTPUT_DOCUMENTS_TAG, OUTPUT_END_TAG } from '@shared/schemas/output';

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

/**
 * console.warn, not the structured trace logger: this module is a leaf schema
 * (`core/definition`, dependency-free by design — see
 * src/agent/core/README.md) and must not pull in the logger's transitive
 * `@shared/schemas` barrel just for deprecation notices. Same pattern as
 * `src/shared/schemas/streamData.ts`'s `warnDroppedItem`.
 */
function warnRetiredSetting(message: string): void {
  console.warn(`[AgentDataclass] ${message}`);
}

function isNonEmptyRecord(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length > 0
  );
}

/**
 * Drop obsolete settings accepted only for legacy YAML and persisted state.
 * Values that carried no behavior (`outputExt`, `prefills`, the default output
 * tags, and materialized empty maps) are dropped silently so old
 * bundled/persisted copies do not pollute CLI stderr; a value that used to do
 * something warns, because the agent now behaves differently:
 *
 * - `documentTag`/`endTag` configured the per-agent output container; every
 *   agent now emits the fixed
 *   `<documents><document name="...">...</document></documents>` protocol (see
 *   `@shared/schemas/output`).
 * - `internal` hid an agent from launcher listings; no agent uses it and every
 *   listing now shows the full category.
 * - `requiredFiles` mapped variables to workspace-relative files; agent-bundled
 *   files live in `requiredFilesInternal` and workspace files are attached per
 *   run as context files.
 * - `filePatternsContain` bound variables to files whose names matched a
 *   pattern within a UI file category.
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
    internal,
    requiredFiles,
    filePatternsContain,
    ...rest
  } = input as Record<string, unknown>;
  const hasLegacyOutputTags = documentTag !== undefined || endTag !== undefined;
  const usesDefaultOutputTags =
    (documentTag === undefined || documentTag === OUTPUT_DOCUMENTS_TAG) &&
    (endTag === undefined || endTag === OUTPUT_END_TAG);
  if (hasLegacyOutputTags && !usesDefaultOutputTags) {
    warnRetiredSetting(
      'settings.documentTag/endTag are no longer configurable — every agent emits the fixed <documents><document name="..."> container. Ignoring the value from this agent definition.',
    );
  }
  if (internal === true) {
    warnRetiredSetting(
      'settings.internal no longer hides an agent — this agent is listed with the rest of its category.',
    );
  }
  if (isNonEmptyRecord(requiredFiles)) {
    warnRetiredSetting(
      'settings.requiredFiles (workspace-relative) is no longer loaded — bundle the file next to the agent YAML and map it under requiredFilesInternal, or attach it as a context file for the run.',
    );
  }
  if (Array.isArray(filePatternsContain) && filePatternsContain.length > 0) {
    warnRetiredSetting(
      'settings.filePatternsContain is no longer loaded — its template variables render empty. Map the file under requiredFilesInternal or attach it as a context file for the run.',
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
const RawAgentSettingInputSchema = z.strictObject({
  ...rawAgentSettingBaseFields,
  ...rawWorkflowSettingFields,
  agentCategory: AgentCategorySchema.optional(),
});

/**
 * Raw YAML settings. This schema validates field shapes without materialising
 * defaults, so inherited child blocks only override fields the author wrote.
 */
const AgentSettingInputSchema = z.preprocess(
  stripLegacySettingFields,
  RawAgentSettingInputSchema,
);

export type AgentSettingInput = z.infer<typeof AgentSettingInputSchema>;

/**
 * Complete root settings before tool-name resolution. Unlike inherited partial
 * settings, the category is known here, so category-specific fields can be
 * checked without importing the tool registry.
 */
export const AgentRootSettingInputSchema = z.preprocess(
  stripLegacySettingFields,
  z.discriminatedUnion('agentCategory', [
    z.strictObject({
      ...rawAgentSettingBaseFields,
      ...rawWorkflowSettingFields,
      agentCategory: z.literal(AgentCategory.Workflow),
    }),
    z.strictObject({
      ...rawAgentSettingBaseFields,
      agentCategory: z.literal(AgentCategory.ToolUse),
    }),
  ]),
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
