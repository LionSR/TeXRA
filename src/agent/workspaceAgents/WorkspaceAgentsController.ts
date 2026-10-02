import { Data, Effect } from 'effect';

import { planTeamRun } from '@common/teams/TeamPlan';
import { findTeamPreset, teamPresets } from '@common/teams/TeamPresets';
import type {
  StateStore,
  StateWriteFailed,
  StateReadFailed,
} from '@platform/interfaces';
import type {
  AgentCategory,
  WorkspaceAgentsCategorySelection,
  WorkspaceAgentsSelection,
  AgentSource,
  ByCategory,
} from '@shared/schemas';
import {
  AGENT_CATEGORIES,
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
  WorkspaceAgentsSelectionSchema,
  byCategory,
  INHERITED_WORKSPACE_AGENTS,
} from '@shared/schemas';
import {
  clearDefaultTeamId,
  getDefaultTeamId,
  setDefaultTeamId,
} from '@shared/state/onboardingState';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { unique } from '@utils/core';

import {
  forgetHiddenAgent,
  readWorkspaceAgentsSelection,
  selectedIdentifiers,
  recordCustomChoices,
  serializeWorkspaceWrite,
  unlistedCustomAgents,
  visibleAgents,
} from './workspaceAgentsState';

export interface WorkspaceAgentsEntry {
  readonly name: string;
  readonly source: AgentSource;
  readonly category: AgentCategory;
}

export class InvalidAgentTeamError extends Data.TaggedError(
  'InvalidAgentTeamError',
)<{ readonly message: string }> {}

export interface WorkspaceAgentsControllerDeps<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
> {
  readonly repoState: StateStore;
  readonly globalState: StateStore;
  readonly getAgents: (category: AgentCategory) => Entry[];
  /** The workspace's persisted custom presets, raw; `teamPresets` parses. */
  readonly getPresets?: () => Effect.Effect<unknown, StateReadFailed>;
  /**
   * Resolve one stored identifier without collapsing exact source identity.
   * The controller applies no fallback around this, so an implementation owns
   * the whole contract: match a bare name against the category's agents, match
   * a source-qualified key exactly, and return nothing for an entry outside
   * `category`. `getCategoryAgent` is the production implementation.
   */
  readonly resolveAgent: (
    category: AgentCategory,
    identifier: string,
  ) => Entry | undefined;
}

export class WorkspaceAgentsController<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
> {
  constructor(private readonly deps: WorkspaceAgentsControllerDeps<Entry>) {}

  /**
   * Every selectable team preset: the shared catalog (`teamPresets`) over the
   * host's custom presets. The one list agent pickers render and every
   * preset lookup reads — a form composing its own preset list can drift from
   * what {@link setTeam} accepts.
   */
  allPresets() {
    return Effect.gen({ self: this }, function* () {
      return teamPresets(
        this.deps.getPresets ? yield* this.deps.getPresets() : undefined,
      );
    });
  }

  /** Resolve one stored identifier by the workspace agents' identity rule. */
  resolveAgent(category: AgentCategory, identifier: string) {
    return this.deps.resolveAgent(category, identifier);
  }

  private getSelection() {
    return readWorkspaceAgentsSelection(this.deps.repoState);
  }

  getDefaultTeamId() {
    return getDefaultTeamId(this.deps.globalState);
  }

  private getEffectiveSelection() {
    return Effect.gen({ self: this }, function* () {
      return (yield* this.resolveEffectiveSelection(yield* this.getSelection()))
        .effectiveSelection;
    });
  }

  /** The team this workspace effectively runs, or null when it runs no team. */
  getActiveTeamId() {
    return Effect.gen({ self: this }, function* () {
      const effective = yield* this.getEffectiveSelection();
      return effective.kind === 'team' ? effective.teamId : null;
    });
  }

  getVisibleAgents(category: AgentCategory) {
    return Effect.gen({ self: this }, function* () {
      const effective = yield* this.getEffectiveSelection();
      const identifiers = selectedIdentifiers(
        effective,
        category,
        yield* this.allPresets(),
      );
      if (identifiers === undefined) {
        return yield* visibleAgents(
          this.deps.repoState,
          this.deps.getAgents(category),
        );
      }
      const { entries } = this.resolveIdentifiers(category, identifiers);
      return [
        ...entries,
        ...(yield* unlistedCustomAgents(
          this.deps.repoState,
          this.deps.getAgents(category),
          entries.map(agentKeyOf),
        )),
      ];
    });
  }

  /** Return the effective stored identifiers, including unavailable members. */
  getEnabledAgentKeys(category: AgentCategory) {
    return Effect.gen({ self: this }, function* () {
      return yield* this.selectionKeys(
        yield* this.getEffectiveSelection(),
        category,
      );
    });
  }

  snapshot() {
    return Effect.gen({ self: this }, function* () {
      const selection = yield* this.getSelection();
      const { effectiveSelection, missingTeamId } =
        yield* this.resolveEffectiveSelection(selection);
      const presets = yield* this.allPresets();
      const unresolvedNames = AGENT_CATEGORIES.flatMap((category) => {
        const identifiers = selectedIdentifiers(
          effectiveSelection,
          category,
          presets,
        );
        if (identifiers === undefined) return [];
        return this.resolveIdentifiers(category, identifiers).missing.map(
          agentName,
        );
      });
      return {
        selection,
        effectiveSelection,
        defaultTeamId: yield* this.getDefaultTeamId(),
        missingTeamId,
        unresolvedNames: unique(unresolvedNames),
      };
    });
  }

  private selectionKeys(
    selection: Exclude<WorkspaceAgentsSelection, { readonly kind: 'inherit' }>,
    category: AgentCategory,
  ) {
    return Effect.gen({ self: this }, function* () {
      const identifiers = selectedIdentifiers(
        selection,
        category,
        yield* this.allPresets(),
      );
      if (identifiers === undefined) return undefined;
      // A custom selection already stores keys, so only an `all`/team selection
      // has names left to resolve; the kind is the same for every identifier.
      const keys =
        selection.kind === 'custom'
          ? unique(identifiers)
          : this.resolveIdentifiers(category, identifiers).keys;
      const unlisted = yield* unlistedCustomAgents(
        this.deps.repoState,
        this.deps.getAgents(category),
        keys,
      );
      return [...keys, ...unlisted.map(agentKeyOf)];
    });
  }

  /**
   * The one walk from stored identifiers to catalog entries. `entries` are the
   * resolved members deduplicated by key; `missing` the identifiers with no
   * entry; `keys` each identifier's canonical key, or the identifier itself
   * when it does not resolve, deduplicated in stored order.
   */
  private resolveIdentifiers(
    category: AgentCategory,
    identifiers: readonly string[],
  ) {
    const entries = new Map<string, Entry>();
    const keys = new Set<string>();
    const missing: string[] = [];
    for (const identifier of identifiers) {
      const entry = this.deps.resolveAgent(category, identifier);
      if (entry) {
        const key = agentKeyOf(entry);
        entries.set(key, entry);
        keys.add(key);
      } else {
        missing.push(identifier);
        keys.add(identifier);
      }
    }
    return { entries: [...entries.values()], missing, keys: [...keys] };
  }

  /** Team identity a selection resolves to, following inherit to the default. */
  private teamIdOf(selection: WorkspaceAgentsSelection) {
    return Effect.gen({ self: this }, function* () {
      if (selection.kind === 'inherit') {
        return yield* this.getDefaultTeamId();
      }
      return selection.kind === 'team' ? selection.teamId : undefined;
    });
  }

  private hasPreset(teamId: string) {
    return Effect.gen({ self: this }, function* () {
      return (yield* this.allPresets()).some((preset) => preset.id === teamId);
    });
  }

  /**
   * Resolve a selection once, answering both questions the snapshot asks of
   * it: what the workspace effectively runs, and — when the selection names a
   * team preset that no longer exists — which team id went missing.
   */
  private resolveEffectiveSelection(selection: WorkspaceAgentsSelection) {
    return Effect.gen({ self: this }, function* () {
      const teamId = yield* this.teamIdOf(selection);
      if (teamId && !(yield* this.hasPreset(teamId))) {
        return {
          effectiveSelection: { kind: 'all' as const },
          missingTeamId: teamId,
        };
      }
      if (selection.kind === 'inherit') {
        return {
          effectiveSelection: teamId
            ? { kind: 'team' as const, teamId }
            : { kind: 'all' as const },
          missingTeamId: undefined,
        };
      }
      return { effectiveSelection: selection, missingTeamId: undefined };
    });
  }

  private effectiveCategorySelection(category: AgentCategory) {
    return Effect.gen({ self: this }, function* () {
      return (
        (yield* this.selectionKeys(
          yield* this.getEffectiveSelection(),
          category,
        )) ?? 'all'
      );
    });
  }

  private writeSelection(
    selection: WorkspaceAgentsSelection,
  ): Effect.Effect<void, StateWriteFailed> {
    const parsed = WorkspaceAgentsSelectionSchema.parse(selection);
    return this.deps.repoState.update(
      WorkspaceStateKey.WORKSPACE_AGENTS,
      parsed,
    );
  }

  private setSelection(
    selection: WorkspaceAgentsSelection,
  ): Effect.Effect<void, StateWriteFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      this.writeSelection(selection),
    );
  }

  /** {@link applyTeam} refusing an unknown team; matches id, name or slug. */
  setTeam(teamId: string) {
    return this.applyTeam(teamId).pipe(
      Effect.filterOrFail(
        (result) => result.status === 'applied',
        () =>
          new InvalidAgentTeamError({
            message: `Unknown agent team: ${teamId}`,
          }),
      ),
      Effect.asVoid,
    );
  }

  /**
   * Store the team `presetId` names and report how its members resolve now.
   * Only the team reference is stored and `preset.agents` re-resolves on read,
   * so a member missing today activates once it appears; `resolution` is
   * evidence for the caller's message.
   */
  applyTeam(presetId: string) {
    return Effect.gen({ self: this }, function* () {
      const preset = findTeamPreset(yield* this.allPresets(), presetId);
      if (!preset) return { status: 'unknown' as const };
      yield* this.setSelection({ kind: 'team', teamId: preset.id });
      return {
        status: 'applied' as const,
        preset,
        resolution: planTeamRun(preset, {
          resolveAgent: (category, identifier) =>
            this.deps.resolveAgent(category, identifier),
        }),
      };
    });
  }

  setCustom(
    agentKeys: ByCategory<WorkspaceAgentsCategorySelection>,
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      Effect.gen({ self: this }, function* () {
        yield* recordCustomChoices(
          this.deps.repoState,
          this.deps.getAgents,
          agentKeys,
        );
        yield* this.writeSelection({
          kind: 'custom',
          agentKeys: byCategory((category) => {
            const selection = agentKeys[category];
            return selection === 'all' ? 'all' : unique(selection);
          }),
        });
      }),
    );
  }

  setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: readonly string[],
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      // The untouched categories' keys are a read of the selection, so it has
      // to happen while the lane is held: `byCategory` evaluates its callback
      // at construction, which is before the lane is acquired. Two calls
      // constructed back to back would otherwise both start from the same
      // pre-lane snapshot and one update would be lost.
      Effect.gen({ self: this }, function* () {
        yield* recordCustomChoices(this.deps.repoState, this.deps.getAgents, {
          [category]: enabledKeys,
        });
        return yield* this.writeSelection({
          kind: 'custom',
          agentKeys: yield* Effect.all(
            byCategory((candidate) =>
              candidate === category
                ? Effect.succeed(unique(enabledKeys))
                : this.effectiveCategorySelection(candidate),
            ),
          ),
        });
      }),
    );
  }

  /** A custom agent the user deleted: its hidden choice goes with it. */
  forgetDeletedAgent(
    name: string,
  ): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
    return forgetHiddenAgent(this.deps.repoState, name);
  }

  /** Every agent, the hidden custom ones included. */
  setAll(): Effect.Effect<void, StateWriteFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      Effect.andThen(
        this.deps.repoState.update(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS, []),
        this.writeSelection({ kind: 'all' }),
      ),
    );
  }

  setInherited(): Effect.Effect<void, StateWriteFailed> {
    return this.setSelection(INHERITED_WORKSPACE_AGENTS);
  }

  setAgentEnabled(input: {
    readonly category: AgentCategory;
    readonly source: AgentSource;
    readonly name: string;
    readonly enabled: boolean;
  }): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      Effect.gen({ self: this }, function* () {
        const selections = yield* Effect.all(
          byCategory((category) => this.effectiveCategorySelection(category)),
        );
        const target =
          selections[input.category] === 'all'
            ? (yield* visibleAgents(
                this.deps.repoState,
                this.deps.getAgents(input.category),
              )).map(agentKeyOf)
            : [...selections[input.category]];
        const key = agentKeyOf(input);
        const index = target.findIndex((candidate) =>
          agentMatchesIdentifier(input, candidate),
        );
        const alreadyEnabled = index >= 0;
        if (input.enabled === alreadyEnabled) return;
        if (input.enabled) {
          target.push(key);
        } else {
          target.splice(index, 1);
        }
        yield* recordCustomChoices(this.deps.repoState, this.deps.getAgents, {
          [input.category]: target,
        });
        return yield* this.writeSelection({
          kind: 'custom',
          agentKeys: byCategory((category) =>
            category === input.category ? target : selections[category],
          ),
        });
      }),
    );
  }

  removeTeamPreset(
    teamId: string,
    removePreset: () => Effect.Effect<void, StateWriteFailed>,
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      Effect.gen({ self: this }, function* () {
        const selection = yield* this.getSelection();
        const clearSelection =
          selection.kind === 'team' && selection.teamId === teamId
            ? this.writeSelection({
                kind: 'custom',
                agentKeys: yield* Effect.all(
                  byCategory((category) =>
                    this.selectionKeys(selection, category).pipe(
                      Effect.map((keys) => keys ?? 'all'),
                    ),
                  ),
                ),
              })
            : Effect.void;
        return yield* Effect.andThen(clearSelection, removePreset());
      }),
    );
  }

  setDefaultTeam(
    teamId: string,
  ): Effect.Effect<void, StateWriteFailed | InvalidAgentTeamError> {
    if (!teamPresets(undefined).some((preset) => preset.id === teamId)) {
      return Effect.fail(
        new InvalidAgentTeamError({
          message: `Only a built-in team can be the user default: ${teamId}`,
        }),
      );
    }
    return setDefaultTeamId(this.deps.globalState, teamId);
  }

  clearDefaultTeam(): Effect.Effect<void, StateWriteFailed> {
    return clearDefaultTeamId(this.deps.globalState);
  }
}
