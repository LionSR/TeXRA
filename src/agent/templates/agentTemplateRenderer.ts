import * as nunjucks from 'nunjucks';

export type AgentTemplateKind = 'toolUse' | 'workflowSingle';

export const AGENT_TEMPLATE_FILES: Record<AgentTemplateKind, string> = {
  toolUse: 'agentTemplate-toolUse.yaml',
  workflowSingle: 'agentTemplate-workflowSingle.yaml',
};

/**
 * Variables the bundled templates accept.
 *
 * Only `AGENT_NAME` and `DESCRIPTION` are required. `TOOLS_YAML` is used by
 * the tool-use template and defaults to the standard tool set.
 */
export interface AgentTemplateVars {
  agentName: string;
  description: string;
  /** YAML list string for the tool-use template, e.g. `    - bash\n    - read_file`. */
  toolsYaml?: string;
}

// Isolated Nunjucks environment so `autoescape: false` does not leak into the
// shared singleton that `nunjucks.configure` / `nunjucks.renderString` would
// otherwise set for every other caller.
const env = new nunjucks.Environment(null, { autoescape: false });

/**
 * Tokens that the generated agent itself needs to keep literal. They are
 * consumed by the agent runtime when the agent runs, not at template-render
 * time. Map each to its literal form so Nunjucks leaves it alone.
 */
const AGENT_RUNTIME_TOKENS = [
  'INSTRUCTION',
  'INPUT_FILE',
  'INPUT_CONTENT',
  'INPUT_FILES',
  'ALL_INPUTS',
  'ALL_CONTEXTS',
  'LIST_OF_ALL_CONTEXTS',
  'ALL_AUXILIARYS',
  'ALL_REFERENCES',
  'ADDITIONAL_INPUTS',
  'REFERENCE_CONTENT',
  'AUXILIARY_CONTENT',
  'OUTPUT_FILES',
] as const;

// Frozen so the shared module-level instance can't be mutated even if a
// caller forgets to spread it before passing to nunjucks.renderString.
const PASSTHROUGH: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    AGENT_RUNTIME_TOKENS.map((token) => [token, `{{ ${token} }}`]),
  ),
);

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
