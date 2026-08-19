import nunjucks from 'nunjucks';

import { buildUserVarPassthrough } from '@agent/prompt/userVars';
import { createTexraNunjucksEnvironment } from '@utils/prompt';

type AgentTemplateKind = 'toolUse' | 'workflowSingle';

export const AGENT_TEMPLATE_FILES: Record<AgentTemplateKind, string> = {
  toolUse: 'agentTemplate-toolUse.yaml',
  workflowSingle: 'agentTemplate-workflowSingle.yaml',
};

// No loader: this environment only renders in-memory template strings, never
// named template files, so `{% include %}`/`{% extends %}` never resolve.
const env = createTexraNunjucksEnvironment(nunjucks);

// Frozen so the shared module-level instance can't be mutated even if a
// caller forgets to spread it before passing to nunjucks.renderString.
const PASSTHROUGH = buildUserVarPassthrough();

export const DEFAULT_AGENT_TEMPLATE_TOOLS_YAML = [
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
]
  .map((tool) => `    - ${tool}`)
  .join('\n');

/**
 * Render a template string with agent-runtime-token passthrough applied.
 *
 * Callers pass their own render variables on top of the passthrough so tokens
 * like `{{ INSTRUCTION }}` that the generated agent expects at runtime survive
 * this render step. Any caller-provided vars win over the passthrough defaults.
 */
export function renderAgentTemplateString(
  templateString: string,
  vars: Record<string, unknown>,
): string {
  return env.renderString(templateString, {
    ...PASSTHROUGH,
    ...vars,
  });
}
