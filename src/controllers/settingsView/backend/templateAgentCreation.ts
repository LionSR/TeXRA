// Standard library imports
import * as path from 'node:path';

// Third-party imports
import { Effect, FileSystem } from 'effect';

// Local imports - agent
import {
  AGENT_TEMPLATE_FILES,
  DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
  renderAgentTemplateString,
} from '@agent/templates/agentTemplateRenderer';
// Local imports - shared
import type { AgentCategory } from '@shared/schemas';
// Local imports - utilities
import { readNormalizedFile } from '@utils/files/fsDurability';
import { entryExists } from '@utils/files/fsEntryExists';

/**
 * "Create an agent from a bundled template" is one operation with one set of
 * rules — the same plan, the same template file, the same collision check, the
 * same rendered substitutions — and only the prompt widget and the editor that
 * opens the result differ per host. The extension's settings handlers and the
 * desktop's settings controller each carried their own copy of the whole
 * sequence; this module owns it, and each host keeps only its dialog.
 */

/** The user-facing name of an agent category, as both pickers spell it. */
export function templateAgentCategoryLabel(category: AgentCategory): string {
  return category === 'toolUse' ? 'Tool Use' : 'Workflow';
}

/** Prompt for the name field of the create-from-template dialog. */
export function templateAgentNamePrompt(category: AgentCategory): string {
  return `Enter a name for the new ${templateAgentCategoryLabel(
    category,
  )} agent (without .yaml extension)`;
}

/** Rejection reason for a proposed custom-agent file name, or null. */
export function validateTemplateAgentName(value: string): string | null {
  if (!value) return 'Name cannot be empty';
  if (value.includes('/') || value.includes('\\')) {
    return 'Name cannot contain path separators';
  }
  if (value.includes(' ')) return 'Use underscores instead of spaces';
  if (/[:#[\]{}|>&*!%@`]/.test(value)) {
    return 'Name cannot contain YAML-special characters';
  }
  return null;
}

/**
 * Render a template agent into its file, refusing to overwrite an existing file.
 * Both settings hosts present the same collision message.
 * `resourcesRoot` is the packaged `…/resources` directory that holds
 * `templates/<kind>.yaml`.
 */
export const writeTemplateAgentFile = Effect.fn(
  'settings.writeTemplateAgentFile',
)(function* (
  input: { category: AgentCategory; name: string; customDir: string },
  resourcesRoot: string,
) {
  const fileName = input.name.endsWith('.yaml')
    ? input.name
    : `${input.name}.yaml`;
  const filePath = path.join(input.customDir, fileName);
  const baseName = input.name.replace(/\.yaml$/, '');
  const isToolUse = input.category === 'toolUse';
  const description = isToolUse
    ? `${baseName} — interactive tool-use agent`
    : `${baseName} — workflow agent`;
  const fs = yield* FileSystem.FileSystem;
  if (yield* entryExists(fs, filePath)) {
    return {
      ok: false,
      message: `A file named "${fileName}" already exists in the custom agents folder.`,
    } as const;
  }
  const raw = yield* readNormalizedFile(
    fs,
    path.join(
      resourcesRoot,
      'templates',
      AGENT_TEMPLATE_FILES[isToolUse ? 'toolUse' : 'workflowSingle'],
    ),
  );
  yield* fs.writeFileString(
    filePath,
    renderAgentTemplateString(raw, {
      AGENT_NAME: baseName,
      DESCRIPTION: description,
      TOOLS_YAML: DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
    }),
  );
  return { ok: true, filePath } as const;
});
