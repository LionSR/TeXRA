// Standard library imports
import * as path from 'node:path';

// Local imports - agent
import {
  AGENT_TEMPLATE_FILES,
  DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
  renderAgentTemplateString,
} from '@agent/templates/agentTemplateRenderer';
// Local imports - shared
import type { AgentCategory } from '@shared/schemas';
// Local imports - utilities
import { AbsoluteFS } from '@utils/files/absoluteFS';

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

/** Plan fields this module needs; a superset lives on the directory controller's plan. */
interface TemplateAgentFilePlan {
  readonly fileName: string;
  readonly filePath: string;
  readonly baseName: string;
  readonly description: string;
  readonly templateKind: 'toolUse' | 'workflowSingle';
}

/**
 * Render a planned template agent into its file.
 *
 * Refuses rather than overwrites when the file already exists, and reports the
 * refusal as a message instead of a code, matching `planOpenAgentYaml` and the
 * rest of this directory: the condition is host-neutral, so the sentence is too.
 * `resourcesRoot` is the packaged `…/resources` directory that holds
 * `templates/<kind>.yaml`.
 */
export async function writeTemplateAgentFile(
  plan: TemplateAgentFilePlan,
  resourcesRoot: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  if (await AbsoluteFS.exists(plan.filePath)) {
    return {
      ok: false,
      message: `A file named "${plan.fileName}" already exists in the custom agents folder.`,
    };
  }
  const raw = await AbsoluteFS.read(
    path.join(
      resourcesRoot,
      'templates',
      AGENT_TEMPLATE_FILES[plan.templateKind],
    ),
  );
  await AbsoluteFS.write(
    plan.filePath,
    renderAgentTemplateString(raw, {
      AGENT_NAME: plan.baseName,
      DESCRIPTION: plan.description,
      TOOLS_YAML: DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
    }),
  );
  return { ok: true };
}
