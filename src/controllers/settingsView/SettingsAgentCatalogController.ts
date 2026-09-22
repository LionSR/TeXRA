// Third-party imports
import { Effect } from 'effect';

// Local imports
import type { InvalidAgentTeamError } from '@agent/roster/AgentRosterController';
import { TeamCatalogPortFailed } from '@common/teams/TeamAvailabilityPreflight';
import {
  findTeamPreset,
  planTeamRun,
  teamPresets,
  type TeamPreset,
} from '@common/teams/TeamPlan';
import {
  resolveTeamRoster,
  type TeamRosterCatalog,
  type TeamRosterPresetResolution,
} from '@common/teams/TeamRoster';
import type { StateWriteFailed, StateReadFailed } from '@platform/interfaces';
import {
  AGENT_CATEGORIES,
  AGENT_MODE_PRESETS_BY_ID,
  agentKey,
  agentKeyOf,
  agentMatchesIdentifier,
  byCategory,
  parseAgentModePresets,
  type AgentCategory,
  type AgentModePreset,
  type AgentSource,
  type ByCategory,
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

export interface SettingsAgentCatalogState {
  getEnabledAgentKeys(
    category: AgentCategory,
  ): Effect.Effect<string[] | undefined, StateReadFailed>;
  setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: string[],
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed>;
  /**
   * The roster refuses an unknown team in its own right, so the port carries
   * that failure beside the write's: `commitPreset` below maps every error it
   * receives into `TeamCatalogPortFailed`, so nothing re-tags it here.
   */
  setTeamRoster(
    preset: AgentModePreset,
  ): Effect.Effect<
    void,
    StateWriteFailed | StateReadFailed | InvalidAgentTeamError
  >;
  getAgents(category: AgentCategory): SettingsAgentCatalogEntry[];
  getVisibleAgents(
    category: AgentCategory,
  ): Effect.Effect<SettingsAgentCatalogEntry[], StateReadFailed>;
  getCustomPresetsRaw(): Effect.Effect<unknown, StateReadFailed>;
  setCustomPresets(
    presets: unknown[],
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed>;
  removeCustomPreset(
    presetId: string,
    remaining: unknown[],
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed>;
}

interface SettingsAgentCatalogControllerDeps {
  state: SettingsAgentCatalogState;
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
        yield* this.deps.state.getCustomPresetsRaw(),
      );
    });
  }

  /** Returns raw records so catalog writes preserve unparsed data. */
  private getCustomPresetRecords() {
    return Effect.gen({ self: this }, function* () {
      const raw = yield* this.deps.state.getCustomPresetsRaw();
      return Array.isArray(raw) ? raw : [];
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
    for (const agent of this.deps.state.getAgents('toolUse')) {
      if (hasDelegationTool(agent.tools)) names.add(agent.name);
    }
    return [...names].sort();
  }

  /**
   * Preview the team root for a preset's tool-use member list. Mirrors launch
   * semantics: the preview plans with the preset's own members only, so a
   * custom team with no delegating members previews no root — the same state
   * the launcher disables with "no runnable team root". Built-in root
   * definitions may be missing from the catalog before the remote catalog
   * loads or the user signs in, so delegation-capable entries are synthesized
   * for built-in root names the preset itself lists.
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
        ? findTeamPreset(
            teamPresets(yield* this.deps.state.getCustomPresetsRaw()),
            presetId,
          )
        : undefined;
      const preset: TeamPreset = knownPreset ?? {
        id: 'settings-preview',
        name: 'Settings preview',
        description: '',
        icon: 'bookmark',
        agents: { workflow: [], toolUse: toolUseAgents },
        texraHostedAgents: [],
        source: 'custom',
      };
      const catalogAgents = this.deps.state.getAgents('toolUse');
      return planTeamRun(preset, {
        agents: {
          workflow: [],
          toolUse: [
            ...catalogAgents,
            ...this.synthesizedBuiltInRootEntries(
              preset.agents.toolUse,
              catalogAgents,
            ),
          ],
        },
      }).rootAgent?.name;
    });
  }

  resolvePreset(presetId: string) {
    return Effect.gen({ self: this }, function* () {
      const preset =
        AGENT_MODE_PRESETS_BY_ID.get(presetId) ??
        (yield* this.getCustomPreset(presetId));
      if (!preset)
        return { ok: false as const, reason: 'unknownPreset' as const };
      return {
        ok: true as const,
        preset,
        resolution: resolveTeamRoster(this.deps.state, preset),
      };
    });
  }

  /** The team port's own failure: this is `TeamRosterCatalog.commitPreset`. */
  commitPreset(
    preset: AgentModePreset,
  ): Effect.Effect<void, TeamCatalogPortFailed> {
    return this.deps.state.setTeamRoster(preset).pipe(
      Effect.mapError(
        (cause) =>
          new TeamCatalogPortFailed({
            member: 'commitPreset',
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
        byCategory((category) => this.deps.state.getVisibleAgents(category)),
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
        texraHostedAgents: AGENT_CATEGORIES.flatMap((category) =>
          visible[category]
            .filter((entry) => entry.source === 'remote')
            .map((entry) => entry.name),
        ),
      };

      return yield* this.deps.state
        .setCustomPresets([...(yield* this.getCustomPresetRecords()), preset])
        .pipe(Effect.as(preset));
    });
  }

  deleteCustomPreset(presetId: string) {
    return Effect.gen({ self: this }, function* () {
      const records = yield* this.getCustomPresetRecords();
      const presets = parseAgentModePresets(records);
      const target = presets.find((preset) => preset.id === presetId);
      if (!target) return null;

      return yield* this.deps.state
        .removeCustomPreset(
          presetId,
          records.filter(
            (record) => !isObject(record) || record.id !== presetId,
          ),
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
      const allAgents = this.deps.state.getAgents(input.category);
      const targetKeys = new Set(
        allAgents
          .filter((entry) => entry.source === input.source)
          .map((entry) => agentKeyOf(entry)),
      );

      const current =
        (yield* this.deps.state.getEnabledAgentKeys(input.category)) ??
        allAgents.map((entry) => agentKeyOf(entry));

      const updated = input.enabled
        ? [...new Set([...current, ...targetKeys])]
        : current.filter((key) => !targetKeys.has(key));

      if (
        updated.length === current.length &&
        updated.every((key, index) => key === current[index])
      ) {
        return;
      }
      return yield* this.deps.state.setEnabledAgentKeys(
        input.category,
        updated,
      );
    });
  }

  private buildCategorySelectionItems(category: AgentCategory) {
    return Effect.gen({ self: this }, function* () {
      const enabledKeys = yield* this.deps.state.getEnabledAgentKeys(category);
      return this.deps.state
        .getAgents(category)
        .map((entry) => this.toSelectionItem(entry, enabledKeys))
        .sort(byName);
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

  /**
   * Delegation-capable stand-ins for built-in team roots the preset lists but
   * the catalog has not loaded yet (pre-sign-in or pre-remote-fetch), so the
   * preview can plan with them without inventing phantom catalog members.
   */
  private synthesizedBuiltInRootEntries(
    toolUseAgents: readonly string[],
    catalogAgents: readonly SettingsAgentCatalogEntry[],
  ): SettingsAgentCatalogEntry[] {
    const knownBuiltInRoots = new Set<string>(BUILTIN_TEAM_ROOT_AGENT_NAMES);
    return [...knownBuiltInRoots]
      .filter(
        (name) =>
          toolUseAgents.some((identifier) =>
            agentMatchesIdentifier(
              { source: 'builtInToolUse', name },
              identifier,
            ),
          ) &&
          !catalogAgents.some(
            (agent) =>
              agentMatchesIdentifier(agent, name) ||
              agentMatchesIdentifier(agent, agentKey('builtInToolUse', name)),
          ),
      )
      .map((name): SettingsAgentCatalogEntry => ({
        name,
        source: 'builtInToolUse',
        category: 'toolUse',
        tools: ['delegate_agent'],
      }));
  }
}
