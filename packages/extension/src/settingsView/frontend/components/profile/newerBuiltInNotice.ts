/** The agent detail pane's notice on a customized copy whose built-in changed. */
import { html, nothing, type TemplateResult } from 'lit';

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { postMessage } from '@texra/shared/hostBridge';
import type { AgentSelectionItem } from '@texra/shared/settingsView/settingsViewMessages';
import { renderLabeledActionButton } from '@ui/wa/actionButtons';
import { renderSettingsBanner } from '@ui/wa/settingsBanner';

/**
 * An app update changed the bundled agent this customized copy overrides:
 * the copy keeps winning until the user resets it or keeps it knowingly.
 */
export function renderNewerBuiltInNotice(
  agent: AgentSelectionItem,
): TemplateResult | typeof nothing {
  const builtInSource = agent.newerBuiltIn;
  if (!builtInSource) return nothing;
  const agentName = agent.name;
  return renderSettingsBanner({
    id: 'agent-newer-built-in',
    variant: 'brand',
    icon: 'arrow-up',
    title: 'A newer built-in version is available',
    description: `Your customized ${agentName} is based on an older version of the built-in agent, and it keeps overriding the new one.`,
    actions: html`${[
      renderLabeledActionButton({
        icon: 'file-lines',
        text: 'View built-in',
        title: 'View the new built-in definition (read-only)',
        kind: 'ghost',
        onClick: () =>
          postMessage(SETTINGS_VIEW_COMMANDS.OPEN_AGENT_YAML, {
            agentName,
            agentSource: builtInSource,
          }),
      }),
      renderLabeledActionButton({
        icon: 'rotate-right',
        text: 'Reset to built-in',
        title: 'Delete your copy so the new built-in version is used',
        kind: 'ghost',
        onClick: () =>
          postMessage(SETTINGS_VIEW_COMMANDS.DELETE_CUSTOM_AGENT, {
            agentName,
          }),
      }),
      renderLabeledActionButton({
        icon: 'check',
        text: 'Keep mine',
        title: 'Keep your copy and dismiss this notice',
        kind: 'ghost',
        onClick: () =>
          postMessage(SETTINGS_VIEW_COMMANDS.KEEP_CUSTOM_AGENT, { agentName }),
      }),
    ]}`,
  });
}
