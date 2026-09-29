// Third-party imports
import { Effect, Result } from 'effect';

// Local imports
import type { AgentRosterController } from '@agent/roster/AgentRosterController';
import { planTeamRun } from '@common/teams/TeamPlan';
import { findTeamPreset, type TeamPreset } from '@common/teams/TeamPresets';
import {
  TeamCatalogPortFailed,
  type TeamRosterCatalog,
} from '@common/teams/TeamRoster';
import type { StateStore } from '@platform/interfaces';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import {
  agentKeyOf,
  agentMatchesIdentifier,
  byCategory,
  parseAgentModePresets,
  type AgentCategory,
  type AgentModePreset,
  type AgentSource,
} from '@shared/schemas';
import { type AgentSelectionItem } from '@shared/settingsView/settingsViewMessages';
import { BUILTIN_TEAM_ROOT_AGENT_NAMES } from '@shared/constants/agents';
import { hasDelegationTool } from '@shared/constants/delegationTools';
import { byName, isObject } from '@utils/core';
import { toErrorMessage } from '@utils/errors/errorMessage';

interface SettingsAgentCatalogEntry {
  name: string;
  source: AgentSource;
  category: AgentCategory;
  description?: string;
  path?: string;
  tools?: string[];
}

interface SettingsAgentCatalogControllerDeps {
  repoState: StateStore;
  roster: AgentRosterController<SettingsAgentCatalogEntry>;
  getAgents(category: AgentCategory): SettingsAgentCatalogEntry[];
  now?: () => number;
}

export class SettingsAgentCatalogController implements TeamRosterCatalog {
  constructor(private readonly deps: SettingsAgentCatalogControllerDeps) {}

  buildSelectionItems() {
    return Effect.gen({ self: this }, function* () {
      return yield* Effect.all(
        byCategory((category) => this.buildCategorySelectionItems(category)),
      );
    });
  }

  getCustomPresets() {
    return Effect.gen({ self: this }, function* () {
      return parseAgentModePresets(
        yield* this.deps.repoState.get(WorkspaceStateKey.CUSTOM_AGENT_PRESETS),
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
    for (const agent of this.deps.getAgents('toolUse')) {
      if (hasDelegationTool(agent.tools)) names.add(agent.name);
    }
    return [...names].sort();
  }

  /**
   * Preview the team root for a preset's tool-use member list. Mirrors launch
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
  getPresetToolUseRoot(toolUseAgents: string[], presetId?: string) {
    return Effect.gen({ self: this }, function* () {
      const knownPreset = presetId
        ? findTeamPreset(yield* this.deps.roster.allPresets(), presetId)
        : undefined;
      const preset: TeamPreset = knownPreset ?? {
        id: 'settings-preview',
        name: 'Settings preview',
        description: '',
        icon: 'bookmark',
        agents: { workflow: [], toolUse: toolUseAgents },
        source: 'custom',
      };
      // Only the tool-use root matters here, so workflow members stay
      // unresolved.
      return planTeamRun(preset, {
        resolveAgent: (category, identifier) =>
          category === 'toolUse'
            ? this.deps.roster.resolveAgent(category, identifier)
            : undefined,
      }).rootAgent?.name;
    });
  }

  resolvePreset(presetId: string) {
    return Effect.gen({ self: this }, function* () {
      const preset = findTeamPreset(
        yield* this.deps.roster.allPresets(),
        presetId,
      );
      if (!preset)
        return { ok: false as const, reason: 'unknownPreset' as const };
      return {
        ok: true as const,
        preset,
        resolution: planTeamRun(preset, {
          resolveAgent: (category, identifier) =>
            this.deps.roster.resolveAgent(category, identifier),
        }),
      };
    });
  }

  /** The team port's own failure: this is `TeamRosterCatalog.commitPreset`. */
  commitPreset(
    preset: AgentModePreset,
  ): Effect.Effect<void, TeamCatalogPortFailed> {
    return this.deps.roster.setTeam(preset.id).pipe(
      Effect.mapError(
        (cause) =>
          new TeamCatalogPortFailed({
            message: `The applied team could not be stored: ${toErrorMessage(cause)}`,
            cause,
          }),
      ),
    );
  }

  saveCurrentPreset(name: string) {
    return Effect.gen({ self: this }, function* () {
      const trimmedName = name.trim();
      const visible = yield* Effect.all(
        byCategory((category) => this.deps.roster.getVisibleAgents(category)),
      );
      const agents = byCategory((category) =>
        visible[category].map((entry) => entry.name),
      );
      const preset: AgentModePreset = {
        id: `custom-${this.deps.now?.() ?? Date.now()}`,
        name: trimmedName,
        description: `Custom team: ${[...agents.toolUse, ...agents.workflow].join(', ')}`,
        icon: 'bookmark',
        agents,
      };

      return yield* this.deps.repoState
        .modify(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, (stored) =>
          Result.succeed([...presetRecords(stored), preset]),
        )
        .pipe(Effect.as(preset));
    });
  }

  deleteCustomPreset(presetId: string) {
    return Effect.gen({ self: this }, function* () {
      const target = yield* this.getCustomPreset(presetId);
      if (!target) return null;

      return yield* this.deps.roster
        .removeTeamPreset(presetId, () =>
          this.deps.repoState
            .modify(WorkspaceStateKey.CUSTOM_AGENT_PRESETS, (stored) =>
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
   * Enable or disable every agent from one source within a category.
   *
   * The identical-list short-circuit is load-bearing: without it every
   * "enable all" click writes the same roster back and republishes the
   * catalog for no change.
   */
  setAllAgentsEnabled(input: {
    category: AgentCategory;
    source: AgentSource;
    enabled: boolean;
  }) {
    return Effect.gen({ self: this }, function* () {
      const allAgents = this.deps.getAgents(input.category);
      const targetKeys = new Set(
        allAgents
          .filter((entry) => entry.source === input.source)
          .map((entry) => agentKeyOf(entry)),
      );

      const current = yield* this.enabledKeys(input.category);

      const updated = input.enabled
        ? [...new Set([...current, ...targetKeys])]
        : current.filter((key) => !targetKeys.has(key));

      if (
        updated.length === current.length &&
        updated.every((key, index) => key === current[index])
      ) {
        return;
      }
      return yield* this.deps.roster.setEnabledAgentKeys(
        input.category,
        updated,
      );
    });
  }

  private buildCategorySelectionItems(category: AgentCategory) {
    return Effect.gen({ self: this }, function* () {
      const enabledKeys = yield* this.enabledKeys(category);
      return this.deps
        .getAgents(category)
        .map((entry) => this.toSelectionItem(entry, enabledKeys))
        .sort(byName);
    });
  }

  /** The enabled keys; an `all` roster enables every visible agent, never a
   *  custom agent the user hid. */
  private enabledKeys(category: AgentCategory) {
    return Effect.gen({ self: this }, function* () {
      return (
        (yield* this.deps.roster.getEnabledAgentKeys(category)) ??
        (yield* this.deps.roster.getVisibleAgents(category)).map(agentKeyOf)
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
      category: entry.category,
      description: entry.description,
      hasPath: Boolean(entry.path),
      filePath: entry.path || undefined,
      tools: entry.tools,
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
