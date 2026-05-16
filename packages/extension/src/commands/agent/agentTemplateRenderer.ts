import * as path from 'path';

import * as vscode from 'vscode';
import * as nunjucks from 'nunjucks';

import { AbsoluteFS } from '@utils/files';

/**
 * Render a bundled agent-template YAML with caller-provided variables.
 *
 * This is the single source of truth for producing template YAML — both the
 * "New agent from template" action in Settings and the AI-creator fallback
 * path call through here. Centralising keeps the output in lockstep with the
 * schema (e.g. `agentCategory`, `prefills` length, `userRequest` shape).
 */

export type AgentTemplateKind = 'toolUse' | 'workflowSingle';

const FILES: Record<AgentTemplateKind, string> = {
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
// otherwise set for every other caller in the extension.
const env = new nunjucks.Environment(null, { autoescape: false });

/**
 * Tokens that the generated agent itself needs to keep literal — they are
 * consumed by the agent runtime when the agent runs, not at template-render
 * time. We map each to its literal form so Nunjucks leaves them alone.
 */
const AGENT_RUNTIME_TOKENS = [
  'INSTRUCTION',
  'INPUT_FILE',
  'INPUT_CONTENT',
  'INPUT_FILES',
  'ALL_INPUTS',
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
  Object.fromEntries(AGENT_RUNTIME_TOKENS.map((v) => [v, `{{ ${v} }}`])),
);

const DEFAULT_TOOLS_YAML = [
  'bash',
  'read_file',
  'write_file',
  'edit_file',
  'glob',
  'grep',
  'ls',
]
  .map((t) => `    - ${t}`)
  .join('\n');

function buildRenderVars(vars: AgentTemplateVars): Record<string, string> {
  return {
    AGENT_NAME: vars.agentName,
    DESCRIPTION: vars.description,
    TOOLS_YAML: vars.toolsYaml ?? DEFAULT_TOOLS_YAML,
  };
}

/**
 * Render a template string with agent-runtime-token passthrough applied.
 *
 * Callers pass their own render variables on top of the passthrough so
 * tokens like `{{ INSTRUCTION }}` that the generated agent expects at
 * runtime survive this render step. Used by:
 *  - `renderAgentTemplateFromBundle` below (Settings "new from template")
 *  - `execFallback` in `agentCreatorCommands.ts` (AI creator fallback)
 *
 * Any caller-provided vars win over the passthrough defaults.
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

export async function renderAgentTemplateFromBundle(
  context: vscode.ExtensionContext,
  kind: AgentTemplateKind,
  vars: AgentTemplateVars,
): Promise<string> {
  const templatePath = path.join(
    context.extensionPath,
    'resources',
    'templates',
    FILES[kind],
  );
  const raw = await AbsoluteFS.read(templatePath);
  return renderAgentTemplateString(raw, buildRenderVars(vars));
}
