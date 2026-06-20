import * as path from 'node:path';

import {
  AGENT_TEMPLATE_FILES,
  DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
  renderAgentTemplateString,
  type AgentTemplateKind,
  type AgentTemplateVars,
} from '@agent/templates/agentTemplateRenderer';
import { AbsoluteFS } from '@utils/files';

import type { ExtensionContext } from 'vscode';

/**
 * Render a bundled agent-template YAML with caller-provided variables.
 *
 * The template expansion rules live in the agent layer. This module only knows
 * where the VS Code extension packages those template files.
 */
export async function renderAgentTemplateFromBundle(
  context: ExtensionContext,
  kind: AgentTemplateKind,
  vars: AgentTemplateVars,
): Promise<string> {
  const templatePath = path.join(
    context.extensionPath,
    'resources',
    'templates',
    AGENT_TEMPLATE_FILES[kind],
  );
  const raw = await AbsoluteFS.read(templatePath);
  return renderAgentTemplateString(raw, {
    AGENT_NAME: vars.agentName,
    DESCRIPTION: vars.description,
    TOOLS_YAML: vars.toolsYaml ?? DEFAULT_AGENT_TEMPLATE_TOOLS_YAML,
  });
}
