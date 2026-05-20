// Third-party imports
import * as vscode from 'vscode';

// Local imports
import {
  getToolUseAgents,
  getVisibleAgents,
  getWorkflowAgents,
  loadAgents,
} from '@agent/index';
import { workspaceSM, WorkspaceStateKey } from '@common/state';
import {
  SettingsAgentCatalogController,
  type SettingsAgentCatalogState,
} from '@controllers/settingsView/SettingsAgentCatalogController';
import { showLoggedErrorMessage } from '@frontend/ui/errorHandlingUtils';
import {
  AGENT_MODE_PRESETS,
  type AgentModePreset,
} from '@shared/schemas/agentPresets';

const CHANNEL = 'AgentTeamCommands';

interface SelectAgentTeamOptions {
  /**
   * Tweaks copy when launched as part of first-run onboarding so the user
   * knows the prompt is optional and where to find it again.
   */
  onboarding?: boolean;
}

type TeamQuickPickItem =
  | (vscode.QuickPickItem & { kind?: undefined; presetId: string })
  | (vscode.QuickPickItem & { kind: vscode.QuickPickItemKind.Separator });

function buildCatalogState(): SettingsAgentCatalogState {
  return {
    getEnabledAgentKeys: (category) =>
      workspaceSM.get<string[]>(
        category === 'workflow'
          ? WorkspaceStateKey.ENABLED_AGENTS
          : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
      ),
    setEnabledAgentKeys: async (category, enabledKeys) => {
      await workspaceSM.update(
        category === 'workflow'
          ? WorkspaceStateKey.ENABLED_AGENTS
          : WorkspaceStateKey.ENABLED_TOOL_USE_AGENTS,
        enabledKeys,
      );
    },
    getAgents: (category) =>
      category === 'workflow' ? getWorkflowAgents() : getToolUseAgents(),
    getVisibleAgents: (category) => getVisibleAgents(category),
    getCustomPresetsRaw: () =>
      workspaceSM.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, []),
    setCustomPresets: async (presets) => {
      await workspaceSM.update(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, presets);
    },
  };
}

function toQuickPickItem(preset: AgentModePreset): TeamQuickPickItem {
  const iconId = preset.icon.replace(/^codicon-/, '');
  return {
    label: `$(${iconId}) ${preset.name}`,
    detail: preset.description,
    presetId: preset.id,
  };
}

function buildItems(
  builtIn: readonly AgentModePreset[],
  custom: readonly AgentModePreset[],
  opts: SelectAgentTeamOptions,
): TeamQuickPickItem[] {
  const items: TeamQuickPickItem[] = builtIn.map(toQuickPickItem);
  if (custom.length > 0) {
    items.push({
      label: 'Custom teams',
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push(...custom.map(toQuickPickItem));
  }
  if (opts.onboarding) {
    items.push({
      label: '',
      kind: vscode.QuickPickItemKind.Separator,
    });
    items.push({
      label: '$(arrow-right) Skip for now',
      detail:
        'Decide later — reopen this picker via "TeXRA: Select Agent Team" or the Multi-Agent tab in Settings.',
      presetId: '',
    });
  }
  return items;
}

/**
 * Show a QuickPick of multi-agent teams and apply the user's choice.
 *
 * Invoked at first-run (with `onboarding: true`) and from the command
 * palette as `TeXRA: Select Agent Team`. Dismissing or skipping leaves
 * current agent visibility untouched.
 */
export async function selectAgentTeam(
  opts: SelectAgentTeamOptions = {},
): Promise<void> {
  try {
    await loadAgents();
    const controller = new SettingsAgentCatalogController({
      state: buildCatalogState(),
    });

    const items = buildItems(
      AGENT_MODE_PRESETS,
      controller.getCustomPresets(),
      opts,
    );

    const placeHolder = opts.onboarding
      ? 'Pick a multi-agent team to start with — you can change this any time'
      : 'Pick a multi-agent team to enable for this workspace';

    const choice = await vscode.window.showQuickPick(items, {
      title: opts.onboarding
        ? 'Welcome to TeXRA — pick your discipline'
        : 'Select agent team',
      placeHolder,
      matchOnDetail: true,
    });

    if (!choice || choice.kind || !choice.presetId) return;

    const result = await controller.applyPreset(choice.presetId);
    if (!result.ok) {
      await vscode.window.showErrorMessage(`Unknown team: ${choice.presetId}`);
      return;
    }

    void vscode.window.showInformationMessage(
      `Applied "${result.preset.name}" team`,
    );

    await vscode.commands.executeCommand('texra.refreshAllOptions');
  } catch (error) {
    await showLoggedErrorMessage(CHANNEL, 'Failed to select agent team', error);
  }
}

export function registerAgentTeamCommands(
  context: vscode.ExtensionContext,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('texra.selectAgentTeam', selectAgentTeam),
  );
}
