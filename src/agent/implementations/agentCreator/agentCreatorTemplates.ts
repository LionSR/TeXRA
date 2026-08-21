/**
 * Parses bundled agent-creator YAML templates and assembles the `CreatorConfig`
 * `runAgentCreator` consumes. Hosts own only resolving where the template
 * files live and reading their bytes; this module owns validating and
 * shaping that content.
 */

import * as yaml from 'yaml';
import { z } from 'zod';

import type { CreatorConfig } from './agentCreatorFlow';

// Validation only — no .trim() transform, so multiline block-scalar prompts
// (including their trailing newline) pass through verbatim.
const PromptStringSchema = z.string().refine((value) => value.trim() !== '', {
  error: 'prompt must not be empty',
});

// Top level stays non-strict: templates carry metadata (name, description,
// settings) that this loader does not consume. The prompts block is strict so
// a misspelled key (e.g. `retryPromt`) fails the load instead of being
// stripped and silently replaced by the built-in fallback.
export const ParsedCreatorYamlSchema = z.object({
  prompts: z.strictObject({
    systemPrompt: PromptStringSchema,
    userRequest: PromptStringSchema,
    retryPrompt: PromptStringSchema.optional(),
  }),
});

function parseCreatorTemplate(fileName: string, raw: string) {
  const parsed = ParsedCreatorYamlSchema.safeParse(yaml.parse(raw));
  if (!parsed.success) {
    throw new Error(
      `Invalid bundled agent-creator template ${fileName}: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

const DEFAULT_RETRY_PROMPT =
  'The previous attempt failed validation: {{ VALIDATION_ERROR }}. Please fix and return only the YAML.';

/** Raw bytes of the four bundled template files, already read by the host. */
export interface CreatorTemplateFiles {
  workflowYaml: string;
  toolUseYaml: string;
  workflowSingle: string;
  toolUseTpl: string;
}

export function buildCreatorConfig(files: CreatorTemplateFiles): CreatorConfig {
  const wf = parseCreatorTemplate(
    'agentCreatorWorkflow.yaml',
    files.workflowYaml,
  );
  const tu = parseCreatorTemplate(
    'agentCreatorToolUse.yaml',
    files.toolUseYaml,
  );
  return {
    workflow: wf.prompts,
    toolUse: tu.prompts,
    retryPrompts: {
      workflow: wf.prompts.retryPrompt ?? DEFAULT_RETRY_PROMPT,
      toolUse: tu.prompts.retryPrompt ?? DEFAULT_RETRY_PROMPT,
    },
    templates: {
      workflowSingle: files.workflowSingle,
      toolUse: files.toolUseTpl,
    },
  };
}
