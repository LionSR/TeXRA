import { Effect, Schema } from 'effect';

import type {
  AgentDirectoriesPort,
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
  /** The app's team membership read (`AgentDirectoriesPort.teamMembers`). */
  readonly teamMembers: AgentDirectoriesPort['teamMembers'];
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

/** A stored selection read once: what the workspace effectively runs, the
 *  identifiers it lists (absent for every agent), and the id of a team it
 *  names that the workspace no longer has. */
interface ResolvedSelection {
  readonly effectiveSelection: Exclude<
    WorkspaceAgentsSelection,
    { readonly kind: 'inherit' }
  >;
  readonly identifiers?: readonly string[];
  readonly missingTeamId?: string;
}

export class WorkspaceAgentsController<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
> {
  private readonly deps: WorkspaceAgentsControllerDeps<Entry>;
  constructor(deps: WorkspaceAgentsControllerDeps<Entry>) {
    this.deps = deps;
  }

  private getSelection() {
    return readWorkspaceAgentsSelection(this.deps.repoState);
  }

  getDefaultTeamId() {
    return Settings.state(this.deps.globalState, DEFAULT_TEAM, TeamIdSchema);
  }

  /** The members of team `teamId`, or `undefined` for a team the workspace
   *  has none of; without the app's teams, every id is unknown. */
  private teamMembers(
    teamId: string,
  ): Effect.Effect<readonly string[] | undefined, StateReadFailed> {
    return (
      this.deps.teamMembers?.(this.deps.repoState, teamId) ??
      Effect.succeed(undefined)
    );
  }

  private resolveStoredSelection() {
    return Effect.flatMap(this.getSelection(), (selection) =>
      this.resolveSelection(selection),
    );
  }

  /** The team this workspace effectively runs, or null when it runs no team. */
  getActiveTeamId() {
    return Effect.map(
      this.resolveStoredSelection(),
      ({ effectiveSelection }) =>
        effectiveSelection.kind === 'team' ? effectiveSelection.teamId : null,
    );
  }

  getVisibleAgents() {
    return Effect.gen({ self: this }, function* () {
      const { identifiers } = yield* this.resolveStoredSelection();
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
    return Effect.flatMap(this.resolveStoredSelection(), (resolved) =>
      this.selectionKeys(resolved),
    );
  }

  snapshot() {
    return Effect.gen({ self: this }, function* () {
      const selection = yield* this.getSelection();
      const { effectiveSelection, identifiers, missingTeamId } =
        yield* this.resolveSelection(selection);
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

  private selectionKeys({
    effectiveSelection,
    identifiers,
  }: ResolvedSelection) {
    return Effect.gen({ self: this }, function* () {
      if (identifiers === undefined) return undefined;
      // A custom selection already stores keys, so only an `all`/team selection
      // has names left to resolve; the kind is the same for every identifier.
      const keys =
        effectiveSelection.kind === 'custom'
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
   * Resolve a selection once (see {@link ResolvedSelection}). A team is read
   * through the app's membership port: one the workspace no longer has reads
   * as every agent, with its id reported.
   */
  private resolveSelection(
    selection: WorkspaceAgentsSelection,
  ): Effect.Effect<ResolvedSelection, StateReadFailed> {
    return Effect.gen({ self: this }, function* () {
      if (selection.kind === 'all') return { effectiveSelection: selection };
      if (selection.kind === 'custom') {
        return {
          effectiveSelection: selection,
          identifiers: selection.agentKeys,
        };
      }
      // The team a selection names, following inherit to the default.
      const teamId =
        selection.kind === 'team'
          ? selection.teamId
          : yield* this.getDefaultTeamId();
      if (teamId === undefined) return { effectiveSelection: { kind: 'all' } };
      const members = yield* this.teamMembers(teamId);
      return members === undefined
        ? { effectiveSelection: { kind: 'all' }, missingTeamId: teamId }
        : {
            effectiveSelection: { kind: 'team', teamId },
            identifiers: members,
          };
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

  /**
   * Store that this workspace runs team `teamId`. Only the reference is
   * stored and the team's members re-resolve on every read, so a member
   * missing today activates once it appears. A team the workspace has none of
   * is refused.
   */
  setTeam(teamId: string) {
    return Effect.andThen(
      this.requireTeam(teamId),
      this.setSelection({ kind: 'team', teamId }),
    );
  }

  /** Fails for a team the workspace has none of. */
  private requireTeam(teamId: string) {
    return Effect.filterOrFail(
      this.teamMembers(teamId),
      (members) => members !== undefined,
      () =>
        new InvalidAgentTeamError({ message: `Unknown agent team: ${teamId}` }),
    );
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

  /**
   * Remove team `teamId` with `removePreset`, in the selection's write lane:
   * a workspace running it keeps its current members as a custom selection.
   */
  removeTeamPreset(
    teamId: string,
    removePreset: () => Effect.Effect<void, StateWriteFailed | StateReadFailed>,
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return serializeWorkspaceWrite(
      this.deps.repoState,
      Effect.gen({ self: this }, function* () {
        const selection = yield* this.getSelection();
        if (selection.kind === 'team' && selection.teamId === teamId) {
          const keys = yield* this.selectionKeys(
            yield* this.resolveSelection(selection),
          );
          yield* this.writeSelection(
            keys === undefined
              ? { kind: 'all' }
              : { kind: 'custom', agentKeys: keys },
          );
        }
        return yield* removePreset();
      }),
    );
  }

  /** The team an inheriting workspace runs; a team the workspace has none of
   *  is refused. The app decides which teams may be a default. */
  setDefaultTeam(teamId: string) {
    return Effect.andThen(
      this.requireTeam(teamId),
      this.deps.globalState.update(DEFAULT_TEAM, teamId),
    );
  }

  clearDefaultTeam(): Effect.Effect<void, StateWriteFailed> {
    return this.deps.globalState.update(DEFAULT_TEAM, undefined);
  }
}
