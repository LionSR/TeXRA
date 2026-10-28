import { Effect, Schema } from 'effect';

import { planTeamRun, type TeamRunPlan } from '@common/teams/TeamPlan';
import { findTeamPreset, teamPresets } from '@common/teams/TeamPresets';
import type {
  StateStore,
  StateWriteFailed,
  StateReadFailed,
} from '@platform/interfaces';
import type { WorkspaceAgentsSelection, AgentSource } from '@shared/schemas';
import {
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
  WorkspaceAgentsSelectionSchema,
  INHERITED_WORKSPACE_AGENTS,
} from '@shared/schemas';
import { Settings } from '@shared/config/settings';
import { GlobalStateKey, WorkspaceStateKey } from '@shared/state/stateKeys';

import {
  forgetHiddenAgent,
  readWorkspaceAgentsSelection,
  selectedIdentifiers,
  recordCustomChoices,
  serializeWorkspaceWrite,
  unlistedCustomAgents,
  visibleAgents,
} from './workspaceAgentsState';

const DEFAULT_TEAM = GlobalStateKey.ACTIVE_TEAM_ID;
const TeamIdSchema = Schema.optional(Schema.NonEmptyString);

export interface WorkspaceAgentsEntry {
  readonly name: string;
  readonly source: AgentSource;
}

export class InvalidAgentTeamError extends Schema.TaggedError<InvalidAgentTeamError>()(
  'InvalidAgentTeamError',
  { message: Schema.String },
) {}

export interface WorkspaceAgentsControllerDeps<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
> {
  readonly repoState: StateStore;
  readonly globalState: StateStore;
  readonly getAgents: () => Entry[];
  /**
   * Resolve one stored identifier without collapsing exact source identity.
   * The controller applies no fallback around this, so an implementation owns
   * the whole contract: match a bare name against the deduplicated agents,
   * and a source-qualified key exactly. `AgentCatalog.get` is the production
   * implementation.
   */
  readonly resolveAgent: (identifier: string) => Entry | undefined;
}

export class WorkspaceAgentsController<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
> {
  private readonly deps: WorkspaceAgentsControllerDeps<Entry>;
  constructor(deps: WorkspaceAgentsControllerDeps<Entry>) {
    this.deps = deps;
  }

  /**
   * Every selectable team preset: the shared catalog (`teamPresets`) over the
   * host's custom presets. The one list agent pickers render and every
   * preset lookup reads — a form composing its own preset list can drift from
   * what {@link setTeam} accepts.
   */
  allPresets() {
    return Effect.gen({ self: this }, function* () {
      // The workspace's persisted custom presets, raw; `teamPresets` parses.
      return teamPresets(
        yield* this.deps.repoState.get(WorkspaceStateKey.CUSTOM_TEAMS),
      );
    });
  }

  /** Resolve one stored identifier by the workspace agents' identity rule. */
  resolveAgent(identifier: string) {
    return this.deps.resolveAgent(identifier);
  }

  private getSelection() {
    return readWorkspaceAgentsSelection(this.deps.repoState);
  }

  getDefaultTeamId() {
    return Settings.state(this.deps.globalState, DEFAULT_TEAM, TeamIdSchema);
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

  getVisibleAgents() {
    return Effect.gen({ self: this }, function* () {
      const effective = yield* this.getEffectiveSelection();
      const identifiers = selectedIdentifiers(
        effective,
        yield* this.allPresets(),
      );
      if (identifiers === undefined) {
        return yield* visibleAgents(this.deps.repoState, this.deps.getAgents());
      }
      const { entries } = this.resolveIdentifiers(identifiers);
      return [
        ...entries,
        ...(yield* unlistedCustomAgents(
          this.deps.repoState,
          this.deps.getAgents(),
          entries.map(agentKeyOf),
        )),
      ];
    });
  }

  /** Return the effective stored identifiers, including unavailable members. */
  getEnabledAgentKeys() {
    return Effect.gen({ self: this }, function* () {
      return yield* this.selectionKeys(yield* this.getEffectiveSelection());
    });
  }

  snapshot() {
    return Effect.gen({ self: this }, function* () {
      const selection = yield* this.getSelection();
      const { effectiveSelection, missingTeamId } =
        yield* this.resolveEffectiveSelection(selection);
      const identifiers = selectedIdentifiers(
        effectiveSelection,
        yield* this.allPresets(),
      );
      const unresolvedNames =
        identifiers === undefined
          ? []
          : this.resolveIdentifiers(identifiers).missing.map(agentName);
      return {
        selection,
        effectiveSelection,
        defaultTeamId: yield* this.getDefaultTeamId(),
        missingTeamId,
        unresolvedNames: [...new Set(unresolvedNames)],
      };
    });
  }

  private selectionKeys(
    selection: Exclude<WorkspaceAgentsSelection, { readonly kind: 'inherit' }>,
  ) {
    return Effect.gen({ self: this }, function* () {
      const identifiers = selectedIdentifiers(
        selection,
        yield* this.allPresets(),
      );
      if (identifiers === undefined) return undefined;
      // A custom selection already stores keys, so only an `all`/team selection
      // has names left to resolve; the kind is the same for every identifier.
      const keys =
        selection.kind === 'custom'
          ? [...new Set(identifiers)]
          : this.resolveIdentifiers(identifiers).keys;
      const unlisted = yield* unlistedCustomAgents(
        this.deps.repoState,
        this.deps.getAgents(),
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
  private resolveIdentifiers(identifiers: readonly string[]) {
    const entries = new Map<string, Entry>();
    const keys = new Set<string>();
    const missing: string[] = [];
    for (const identifier of identifiers) {
      const entry = this.deps.resolveAgent(identifier);
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

  /**
   * Resolve a selection once, answering both questions the snapshot asks of
   * it: what the workspace effectively runs, and — when the selection names a
   * team preset that no longer exists — which team id went missing.
   */
  private resolveEffectiveSelection(selection: WorkspaceAgentsSelection) {
    return Effect.gen({ self: this }, function* () {
      // The team a selection names, following inherit to the default.
      let teamId: string | undefined;
      if (selection.kind === 'inherit') teamId = yield* this.getDefaultTeamId();
      else if (selection.kind === 'team') teamId = selection.teamId;
      if (
        teamId &&
        !(yield* this.allPresets()).some((preset) => preset.id === teamId)
      ) {
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

  private writeSelection(
    selection: WorkspaceAgentsSelection,
  ): Effect.Effect<void, StateWriteFailed> {
    return this.deps.repoState.update(
      WorkspaceStateKey.WORKSPACE_AGENTS,
      Schema.decodeSync(WorkspaceAgentsSelectionSchema)(selection),
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
   * evidence for the caller's message. A launch picks the team's root, so
   * none is planned here.
   */
  applyTeam(presetId: string) {
    return Effect.gen({ self: this }, function* () {
      const preset = findTeamPreset(yield* this.allPresets(), presetId);
      if (!preset) return { status: 'unknown' as const };
      yield* this.setSelection({ kind: 'team', teamId: preset.id });
      const resolution: Pick<TeamRunPlan, 'agentKeys' | 'missingAgents'> =
        planTeamRun(preset, {
          resolveAgent: (identifier) => this.deps.resolveAgent(identifier),
          rootAgentNames: [],
        });
      return { status: 'applied' as const, preset, resolution };
    });
  }

  /** Exactly the agents `agentKeys` names, in that order. */
  setEnabledAgentKeys(
    agentKeys: readonly string[],
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      Effect.gen({ self: this }, function* () {
        yield* recordCustomChoices(
          this.deps.repoState,
          this.deps.getAgents(),
          agentKeys,
        );
        yield* this.writeSelection({
          kind: 'custom',
          agentKeys: [...new Set(agentKeys)],
        });
      }),
    );
  }

  /** A custom agent the user deleted: its hidden choice goes with it. */
  forgetDeletedAgent(name: string): Effect.Effect<void, StateWriteFailed> {
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
    readonly source: AgentSource;
    readonly name: string | readonly string[];
    readonly enabled: boolean;
  }): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      Effect.gen({ self: this }, function* () {
        const { repoState } = this.deps;
        const target = [
          ...((yield* this.getEnabledAgentKeys()) ??
            (yield* visibleAgents(repoState, this.deps.getAgents())).map(
              agentKeyOf,
            )),
        ];
        // Every name flips the same way, so the length says if any changed.
        const before = target.length;
        for (const name of [input.name].flat()) {
          const agent = { source: input.source, name };
          const index = target.findIndex((candidate) =>
            agentMatchesIdentifier(agent, candidate),
          );
          if (input.enabled === index >= 0) continue;
          if (input.enabled) target.push(agentKeyOf(agent));
          else target.splice(index, 1);
        }
        if (target.length === before) return;
        yield* recordCustomChoices(repoState, this.deps.getAgents(), target);
        return yield* this.writeSelection({
          kind: 'custom',
          agentKeys: target,
        });
      }),
    );
  }

  removeTeamPreset(
    teamId: string,
    removePreset: () => Effect.Effect<void, StateWriteFailed | StateReadFailed>,
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      Effect.gen({ self: this }, function* () {
        const selection = yield* this.getSelection();
        const clearSelection =
          selection.kind === 'team' && selection.teamId === teamId
            ? Effect.flatMap(this.selectionKeys(selection), (keys) =>
                this.writeSelection(
                  keys === undefined
                    ? { kind: 'all' }
                    : { kind: 'custom', agentKeys: keys },
                ),
              )
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
    return this.deps.globalState.update(DEFAULT_TEAM, teamId);
  }

  clearDefaultTeam(): Effect.Effect<void, StateWriteFailed> {
    return this.deps.globalState.update(DEFAULT_TEAM, undefined);
  }
}
