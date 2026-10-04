// Third-party imports
import { Effect, Result } from 'effect';

// Local imports
import type { WorkspaceAgentsController } from '@agent/workspaceAgents/WorkspaceAgentsController';
import { planTeamRun } from '@common/teams/TeamPlan';
import { findTeamPreset, type TeamPreset } from '@common/teams/TeamPresets';
import type { StateStore } from '@platform/interfaces';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  agentKeyOf,
  agentMatchesIdentifier,
  parseAgentModePresets,
  type AgentModePreset,
  type AgentSource,
} from '@shared/schemas';
import { type AgentSelectionItem } from '@shared/settingsView/settingsViewMessages';
import { BUILTIN_TEAM_ROOT_AGENT_NAMES } from '@shared/constants/agents';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { byName, isObject } from '@utils/core';

interface SettingsAgentCatalogEntry {
  name: string;
  source: AgentSource;
  /** Its file's `task` block, or null for a chat agent. */
  task: object | null;
  description?: string;
  path?: string;
  tools?: string[];
  basedOn?: string;
}

interface SettingsAgentCatalogControllerDeps {
  repoState: StateStore;
  workspaceAgents: WorkspaceAgentsController<SettingsAgentCatalogEntry>;
  getAgents(): SettingsAgentCatalogEntry[];
  /** The source of the changed bundled agent a customized copy overrides. */
  newerBuiltInOf(entry: SettingsAgentCatalogEntry): AgentSource | undefined;
  now?: () => number;
}

export class SettingsAgentCatalogController {
  constructor(private readonly deps: SettingsAgentCatalogControllerDeps) {}

  buildSelectionItems() {
    return Effect.gen({ self: this }, function* () {
      const enabledKeys = yield* this.enabledKeys();
      return this.deps
        .getAgents()
        .map((entry) => this.toSelectionItem(entry, enabledKeys))
        .sort(byName);
    });
  }

  getCustomPresets() {
    return Effect.gen({ self: this }, function* () {
      return parseAgentModePresets(
        yield* this.deps.repoState.get(WorkspaceStateKey.CUSTOM_TEAMS),
      );
    });
  }

  getCustomPreset(presetId: string) {
    return Effect.gen({ self: this }, function* () {
      return (
        (yield* this.getCustomPresets()).find(
          (preset) => preset.id === presetId,
        ) ?? null
      );
    });
  }

  getOrchestratorAgentNames(): string[] {
    const names = new Set<string>(BUILTIN_TEAM_ROOT_AGENT_NAMES);
    for (const agent of this.deps.getAgents()) {
      if (hasDelegationTool(agent.tools)) names.add(agent.name);
    }
    return [...names].sort();
  }

  /**
   * Preview the team root for a preset's member list. Mirrors launch
   * semantics: the preview plans with the preset's own members only, so a
   * custom team with no delegating members previews no root — the same state
   * the launcher disables with "no runnable team root".
   *
   * When `presetId` resolves to a launchable preset, the preview reuses that
   * preset's provenance and member lists so a built-in team plans with
   * built-in root semantics (search only BUILTIN_TEAM_ROOT_AGENT_NAMES, no
   * preset-order-first or first-delegating-member fallback) — the same root
   * `planTeamRun` picks for that team at launch. Ad-hoc member lists without
   * a resolvable id keep custom-preset semantics.
   */
  getPresetRoot(members: string[], presetId?: string) {
    return Effect.gen({ self: this }, function* () {
      const knownPreset = presetId
        ? findTeamPreset(
            yield* this.deps.workspaceAgents.allPresets(),
            presetId,
          )
        : undefined;
      const preset: TeamPreset = knownPreset ?? {
        id: 'settings-preview',
        name: 'Settings preview',
        description: '',
        icon: 'bookmark',
        agents: members,
        source: 'custom',
      };
      return planTeamRun(preset, {
        resolveAgent: (identifier) =>
          this.deps.workspaceAgents.resolveAgent(identifier),
      }).rootAgent?.name;
    });
  }

  saveCurrentPreset(name: string) {
    return Effect.gen({ self: this }, function* () {
      const trimmedName = name.trim();
      const agents = (yield* this.deps.workspaceAgents.getVisibleAgents()).map(
        (entry) => entry.name,
      );
      const preset: AgentModePreset = {
        id: `custom-${this.deps.now?.() ?? Date.now()}`,
        name: trimmedName,
        description: `Custom team: ${agents.join(', ')}`,
        icon: 'bookmark',
        agents,
      };

      return yield* this.deps.repoState
        .modify(WorkspaceStateKey.CUSTOM_TEAMS, (stored) =>
          Result.succeed([...presetRecords(stored), preset]),
        )
        .pipe(Effect.as(preset));
    });
  }

  deleteCustomPreset(presetId: string) {
    return Effect.gen({ self: this }, function* () {
      const target = yield* this.getCustomPreset(presetId);
      if (!target) return null;

      return yield* this.deps.workspaceAgents
        .removeTeamPreset(presetId, () =>
          this.deps.repoState
            .modify(WorkspaceStateKey.CUSTOM_TEAMS, (stored) =>
              Result.succeed(
                presetRecords(stored).filter(
                  (record) => !isObject(record) || record.id !== presetId,
                ),
              ),
            )
            .pipe(Effect.asVoid),
        )
        .pipe(Effect.as(target));
    });
  }

  /**
   * Enable or disable every agent from one source.
   *
   * The identical-list short-circuit is load-bearing: without it every
   * "enable all" click writes the same agent list back and republishes the
   * catalog for no change.
   */
  setAllAgentsEnabled(input: { source: AgentSource; enabled: boolean }) {
    return Effect.gen({ self: this }, function* () {
      const allAgents = this.deps.getAgents();
      const targetKeys = new Set(
        allAgents
          .filter((entry) => entry.source === input.source)
          .map((entry) => agentKeyOf(entry)),
      );

      const current = yield* this.enabledKeys();

      const updated = input.enabled
        ? [...new Set([...current, ...targetKeys])]
        : current.filter((key) => !targetKeys.has(key));

      if (
        updated.length === current.length &&
        updated.every((key, index) => key === current[index])
      ) {
        return;
      }
      return yield* this.deps.workspaceAgents.setEnabledAgentKeys(updated);
    });
  }

  /** The enabled keys; an `all` agent list enables every visible agent, never a
   *  custom agent the user hid. */
  private enabledKeys() {
    return Effect.gen({ self: this }, function* () {
      return (
        (yield* this.deps.workspaceAgents.getEnabledAgentKeys()) ??
        (yield* this.deps.workspaceAgents.getVisibleAgents()).map(agentKeyOf)
      );
    });
  }

  private toSelectionItem(
    entry: SettingsAgentCatalogEntry,
    enabledKeys: string[] | undefined,
  ): AgentSelectionItem {
    return {
      name: entry.name,
      source: entry.source,
      hasTask: entry.task !== null,
      description: entry.description,
      hasPath: Boolean(entry.path),
      filePath: entry.path || undefined,
      tools: entry.tools,
      newerBuiltIn: this.deps.newerBuiltInOf(entry),
      // undefined = never configured -> all enabled; [] = explicitly none enabled.
      // A stored list holds resolved `source:name` keys, but older workspaces
      // persisted bare names, which `agentMatchesIdentifier` still matches.
      enabled:
        enabledKeys?.some((key) => agentMatchesIdentifier(entry, key)) ?? true,
    };
  }
}

/** The stored preset records as they are, unparsed, so a catalog write
 *  preserves records this version cannot read. */
function presetRecords(stored: unknown): unknown[] {
  return Array.isArray(stored) ? stored : [];
}
