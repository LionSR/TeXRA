// Third-party imports
import * as vscode from 'vscode';

// Local imports - agent utilities
import { buildGroupedAgentOptions } from '@agent/utils/agentOptionMetadata';
import { loadAgentOptionInputs } from '@agent/utils/agentOptionSources';

/**
 * Compute agent <option> tags for the agent dropdown.
 * Agents missing a YAML definition are marked as disabled and cannot be selected.
 * A codicon indicator is added via data-multiple when a corresponding
 * `_multiple.yaml` file exists.
 */
export async function computeAgentOptions(
  context: vscode.ExtensionContext,
): Promise<string> {
  const { agentNames, directories } = await loadAgentOptionInputs(context);

  if (agentNames.length === 0) {
    return '';
  }

  return buildGroupedAgentOptions(agentNames, directories);
}
