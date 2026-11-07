// Third-party imports
import { parseDocument } from 'yaml';

type AgentTemplateKind = 'toolUse' | 'workflowSingle';

export const AGENT_TEMPLATE_FILES: Record<AgentTemplateKind, string> = {
  toolUse: 'agentTemplate-toolUse.yaml',
  workflowSingle: 'agentTemplate-workflowSingle.yaml',
};

/**
 * The agent file a bundled template creates: the template, itself a valid
 * agent file, with its `name` and `description` replaced. The template is
 * edited as YAML data, never rendered, so its prompt and task templates reach
 * the run untouched and render once, when the agent runs. Comments and block
 * scalars are kept as written.
 */
export function agentFileFromTemplate(
  templateYaml: string,
  fields: { readonly name: string; readonly description: string },
): string {
  const document = parseDocument(templateYaml);
  // A bundled template that does not parse is a packaging defect.
  const [error] = document.errors;
  if (error) throw error;
  document.set('name', fields.name);
  document.set('description', fields.description);
  return document.toString();
}
