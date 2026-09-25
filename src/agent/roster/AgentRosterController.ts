import { Effect } from 'effect';

import { teamPresets } from '@common/teams/TeamPresets';
import { withLogChannel } from '@logger/effectLog';
import type {
  StateStore,
  StateWriteFailed,
  StateReadFailed,
} from '@platform/interfaces';
import type {
  AgentCategory,
  AgentModePreset,
  AgentRosterCategorySelection,
  AgentRosterSelection,
  AgentSource,
  ByCategory,
} from '@shared/schemas';
import {
  AGENT_CATEGORIES,
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
  AgentRosterSelectionSchema,
  byCategory,
  INHERITED_AGENT_ROSTER,
} from '@shared/schemas';
import {
  clearDefaultTeamId,
  getDefaultTeamId,
  setDefaultTeamId,
} from '@shared/state/onboardingState';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { unique } from '@utils/core';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';

const CHANNEL = 'AgentRosterController';

export interface AgentRosterEntry {
  readonly name: string;
  readonly source: AgentSource;
  readonly category: AgentCategory;
}

export class InvalidAgentTeamError extends Error {}

export interface AgentRosterControllerDeps<
  Entry extends AgentRosterEntry = AgentRosterEntry,
> {
  readonly workspaceState: StateStore;
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

/**
 * One write at a time per store, module-wide. The roster's write is a
 * read-modify-write of one key: two selection changes that interleave would
 * let the second read the selection the first has not stored yet. The lane
 * is the store, and its lifetime is the last fiber holding or waiting on it.
 */
const workspaceWriteLanes = new Map<StateStore, PerKeyLane>();

function serializeWorkspaceWrite<A, E>(
  store: StateStore,
  write: Effect.Effect<A, E>,
): Effect.Effect<A, E> {
  return write.pipe(withPerKeyLane(workspaceWriteLanes, store));
}

/**
 * Read the canonical workspace selection. The reader is deliberately pure. It
 * used to repair the stored value in place, but the read-modify-write
 * mutations (`setEnabledAgentKeys`, `setAgentEnabled`, `removeTeamPreset`)
 * read the selection while already holding the write mutex, so a repair
 * issued from here either races that mutation or, if serialized behind it,
 * overwrites the selection the mutation just committed. The mutations own
 * every durable write.
 */
function readAgentRosterSelection(workspaceState: StateStore) {
  return Effect.gen(function* () {
    const raw = yield* workspaceState.get<unknown>(
      WorkspaceStateKey.AGENT_ROSTER_SELECTION,
    );
    if (raw === undefined) return INHERITED_AGENT_ROSTER;
    const parsed = AgentRosterSelectionSchema.safeParse(raw);
    if (parsed.success) return parsed.data;
    yield* Effect.logWarning(
      `Ignoring malformed roster selection; falling back to ` +
        `the inherited roster: ${parsed.error.message}`,
    ).pipe(withLogChannel(CHANNEL));
    return INHERITED_AGENT_ROSTER;
  });
}

function selectedIdentifiers(
  selection: Exclude<AgentRosterSelection, { readonly kind: 'inherit' }>,
  category: AgentCategory,
  presets: readonly AgentModePreset[],
): readonly string[] | undefined {
  if (selection.kind === 'all') return undefined;
  if (selection.kind === 'custom') {
    const categorySelection = selection.agentKeys[category];
    return categorySelection === 'all' ? undefined : categorySelection;
  }
  const preset = presets.find((candidate) => candidate.id === selection.teamId);
  if (!preset) return undefined;
  return preset.agents[category];
}

export class AgentRosterController<
  Entry extends AgentRosterEntry = AgentRosterEntry,
> {
  constructor(private readonly deps: AgentRosterControllerDeps<Entry>) {}

  /**
   * Every selectable team preset: the shared catalog (`teamPresets`) over the
   * host's custom presets. The one list roster pickers render and every
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

  /** Resolve one stored identifier by the roster's identity rule. */
  resolveAgent(category: AgentCategory, identifier: string) {
    return this.deps.resolveAgent(category, identifier);
  }

  private getSelection() {
    return readAgentRosterSelection(this.deps.workspaceState);
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
      if (identifiers === undefined) return this.deps.getAgents(category);

      const resolved = identifiers
        .map((identifier) => this.deps.resolveAgent(category, identifier))
        .filter((entry): entry is Entry => entry !== undefined);
      return [
        ...new Map(
          resolved.map((entry) => [agentKeyOf(entry), entry]),
        ).values(),
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
        return identifiers
          .filter((identifier) => !this.deps.resolveAgent(category, identifier))
          .map(agentName);
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
    selection: Exclude<AgentRosterSelection, { readonly kind: 'inherit' }>,
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
      if (selection.kind === 'custom') return unique(identifiers);

      return unique(
        identifiers.map((identifier) => {
          const entry = this.deps.resolveAgent(category, identifier);
          return entry ? agentKeyOf(entry) : identifier;
        }),
      );
    });
  }

  /** Team identity a selection resolves to, following inherit to the default. */
  private teamIdOf(selection: AgentRosterSelection) {
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
  private resolveEffectiveSelection(selection: AgentRosterSelection) {
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

  private materializeCategorySelection(
    selection: AgentRosterCategorySelection,
    category: AgentCategory,
  ): string[] {
    return selection === 'all'
      ? this.deps.getAgents(category).map(agentKeyOf)
      : [...selection];
  }

  private writeSelection(
    selection: AgentRosterSelection,
  ): Effect.Effect<void, StateWriteFailed> {
    const parsed = AgentRosterSelectionSchema.parse(selection);
    return this.deps.workspaceState.update(
      WorkspaceStateKey.AGENT_ROSTER_SELECTION,
      parsed,
    );
  }

  private setSelection(
    selection: AgentRosterSelection,
  ): Effect.Effect<void, StateWriteFailed> {
    return serializeWorkspaceWrite(
      this.deps.workspaceState,
      this.writeSelection(selection),
    );
  }

  setTeam(teamId: string) {
    return Effect.gen({ self: this }, function* () {
      const preset = (yield* this.allPresets()).find(
        (candidate) => candidate.id === teamId,
      );
      if (!preset) {
        // A refusal in the declared channel, not a synchronous throw. This
        // method's two production callers are a synchronous TUI select handler
        // (which would otherwise let the throw escape its Effect recovery) and a
        // CLI `await` that matches on `instanceof InvalidAgentTeamError` against
        // the rejection — a defect would break the second one's message.
        return yield* Effect.fail(
          new InvalidAgentTeamError(`Unknown agent team: ${teamId}`),
        );
      }
      return yield* this.setSelection({ kind: 'team', teamId: preset.id });
    });
  }

  setCustom(
    agentKeys: ByCategory<AgentRosterCategorySelection>,
  ): Effect.Effect<void, StateWriteFailed> {
    return this.setSelection({
      kind: 'custom',
      agentKeys: byCategory((category) => {
        const selection = agentKeys[category];
        return selection === 'all' ? 'all' : unique(selection);
      }),
    });
  }

  setEnabledAgentKeys(
    category: AgentCategory,
    enabledKeys: readonly string[],
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.workspaceState,
      // The untouched categories' keys are a read of the selection, so it has
      // to happen while the lane is held: `byCategory` evaluates its callback
      // at construction, which is before the lane is acquired. Two calls
      // constructed back to back would otherwise both start from the same
      // pre-lane snapshot and one update would be lost.
      Effect.gen({ self: this }, function* () {
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

  setAll(): Effect.Effect<void, StateWriteFailed> {
    return this.setSelection({ kind: 'all' });
  }

  setInherited(): Effect.Effect<void, StateWriteFailed> {
    return this.setSelection(INHERITED_AGENT_ROSTER);
  }

  setAgentEnabled(input: {
    readonly category: AgentCategory;
    readonly source: AgentSource;
    readonly name: string;
    readonly enabled: boolean;
  }): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.workspaceState,
      Effect.gen({ self: this }, function* () {
        const selections = yield* Effect.all(
          byCategory((category) => this.effectiveCategorySelection(category)),
        );
        const target = this.materializeCategorySelection(
          selections[input.category],
          input.category,
        );
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
      this.deps.workspaceState,
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
        new InvalidAgentTeamError(
          `Only a built-in team can be the user default: ${teamId}`,
        ),
      );
    }
    return setDefaultTeamId(this.deps.globalState, teamId);
  }

  clearDefaultTeam(): Effect.Effect<void, StateWriteFailed> {
    return clearDefaultTeamId(this.deps.globalState);
  }
}
