// Standard library imports
import * as path from 'path';

// Third-party imports
import { globSync } from 'glob';

// Local imports - utilities
import { getConfig } from '@utils/config';
import { GlobalStorageFS, AbsoluteFS } from '@utils/files';

/**
 * Compute agent <option> tags, disabling entries whose YAML definition
 * cannot be found in any configured directory.
 */
export function computeAgentOptions(): string {
  const agents = getConfig<string[]>('agents', []);
  const includeToolUse = getConfig<boolean>('includeToolUseAgents', false);
  const toolUseDir = GlobalStorageFS.fullPath('tool_use_agents');
  let extraAgents: string[] = [];
  if (includeToolUse) {
    try {
      extraAgents = AbsoluteFS.readDirSync(toolUseDir)
        .filter((f) => f.endsWith('.yaml'))
        .map((f) => path.basename(f, '.yaml'));
    } catch {
      extraAgents = [];
    }
  }
  const allAgents = Array.from(new Set([...agents, ...extraAgents]));

  const customDir = getConfig<string>('explorer.agentsDirectory', '');
  const builtInDir = GlobalStorageFS.fullPath('agents');
  const builtInToolUseDir = GlobalStorageFS.fullPath('tool_use_agents');

  const optionTags = allAgents.map((agent) => {
    const fileName = `${agent}.yaml`;
    let exists = false;
    if (customDir && path.isAbsolute(customDir)) {
      const matches = globSync(`**/${fileName}`, {
        cwd: customDir,
        nodir: true,
        dot: false,
      });
      exists = matches.length > 0;
    }
    if (!exists) {
      const builtInMatch = globSync(`**/${fileName}`, {
        cwd: builtInDir,
        nodir: true,
        dot: false,
      });
      const toolUseMatch = globSync(`**/${fileName}`, {
        cwd: builtInToolUseDir,
        nodir: true,
        dot: false,
      });
      exists = builtInMatch.length > 0 || toolUseMatch.length > 0;
    }
    const missingAttr = exists
      ? ''
      : ' class="disabled-agent" title="Agent configuration not found"';
    return `<option value="${agent}"${missingAttr}>${agent}</option>`;
  });

  return optionTags.join('\n');
}
