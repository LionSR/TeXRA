import { Effect } from 'effect';
import { readCustomAgentDir } from '@shared/config/settingsAccess';
/**
 * Agent selection / custom-directory / mode-preset outbound message builders.
 *
 * Both graphical hosts share these wire shapes. State reads remain Effects
 * in the host program; no controller-specific forwarding ports are needed.
 */

import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import type { AgentModePreset } from '@shared/schemas';
import type { AgentScanIssue } from '@shared/schemas';
import type {
  AgentSelectionItem,
  UpdateCustomAgentDirMessage,
} from '@texra/shared/settingsView/settingsViewMessages';
import type { StateStore, StateReadFailed } from '@texra-ai/harness';

export interface AgentSelectionPorts {
  buildSelectionItems(): Effect.Effect<AgentSelectionItem[], StateReadFailed>;
  getCustomAgentScanIssues(): readonly AgentScanIssue[];
}

export function buildAgentSelectionMessage(ports: AgentSelectionPorts) {
  return Effect.gen(function* () {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_SELECTION,
      agents: yield* ports.buildSelectionItems(),
      customAgentIssues: [...ports.getCustomAgentScanIssues()],
    };
  });
}

export function buildCustomAgentDirMessage<E, R = never>(
  globalState: StateStore,
  customDir: Effect.Effect<string, E, R>,
): Effect.Effect<UpdateCustomAgentDirMessage, E | StateReadFailed, R> {
  return Effect.gen(function* () {
    const configuredPath = yield* readCustomAgentDir(globalState);
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_CUSTOM_AGENT_DIR,
      path: yield* customDir,
      isDefault: configuredPath === '',
    };
  });
}

export interface AgentModePresetsPorts {
  getCustomPresets(): Effect.Effect<AgentModePreset[], StateReadFailed>;
  getOrchestratorAgentNames(): string[];
  getActiveTeamId(): Effect.Effect<string | null, StateReadFailed>;
}

export function buildAgentModePresetsMessage(ports: AgentModePresetsPorts) {
  return Effect.gen(function* () {
    return {
      command: SETTINGS_VIEW_COMMANDS.UPDATE_AGENT_MODE_PRESETS,
      customPresets: yield* ports.getCustomPresets(),
      orchestratorAgents: ports.getOrchestratorAgentNames(),
      activePresetId: yield* ports.getActiveTeamId(),
    };
  });
}
