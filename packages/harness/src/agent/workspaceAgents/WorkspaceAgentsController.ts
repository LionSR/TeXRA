import { Effect, Option, Result, Schema } from 'effect';

import type { AgentDirectoriesPort } from '@platform/interfaces';
import {
  Settings,
  StateWriteFailed,
  type StateReadFailed,
  type StateStore,
} from '@shared/config/settings';
import type { WorkspaceAgentsSelection, AgentSource } from '@shared/schemas';
import {
  agentKeyOf,
  agentMatchesIdentifier,
  agentName,
  INHERITED_WORKSPACE_AGENTS,
  WorkspaceAgentsSelectionSchema,
} from '@shared/schemas';
import type { StateKey } from '@shared/state/stateSettings';

import {
  HIDDEN_CUSTOM_AGENTS_KEY,
  WORKSPACE_AGENTS_KEY,
  storedHidden,
  unlistedCustomAgents,
  visibleAgents,
  withCustomChoices,
} from './workspaceAgentsState';

/** The team a workspace runs (`apply_team`, the settings view). The stored
 *  key keeps the spelling it was first written under. */
export const ACTIVE_TEAM_ID_KEY = {
  key: 'onboarding.defaultTeamId',
  slot: 'globalState',
  schema: Schema.optional(Schema.NonEmptyString),
} as const satisfies StateKey<string | undefined>;

const SELECTION = WORKSPACE_AGENTS_KEY.key;
const HIDDEN = HIDDEN_CUSTOM_AGENTS_KEY.key;

/** How many times a selection change is decided again while another writer
 *  stores the selection between its read and its write. */
const SELECTION_CHANGE_ATTEMPTS = 8;

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

/** A selection in the form the store keeps. */
const storedSelection = (selection: WorkspaceAgentsSelection) =>
  Schema.decodeSync(WorkspaceAgentsSelectionSchema)(selection);

/** A stored selection as every read decodes it: one that no longer decodes
 *  reads as inherited. */
const decodedSelection = (stored: unknown): WorkspaceAgentsSelection =>
  Result.getOrElse(
    Schema.decodeUnknownResult(WORKSPACE_AGENTS_KEY.schema)(stored),
    () => INHERITED_WORKSPACE_AGENTS,
  );

/** A stored hidden list as every read takes it: a malformed one, which the
 *  reads report, as none. A write refuses it instead ({@link storedHidden}). */
const readableHidden = (stored: unknown): readonly string[] =>
  Result.getOrElse(storedHidden(stored), () => []);

export class WorkspaceAgentsController<
  Entry extends WorkspaceAgentsEntry = WorkspaceAgentsEntry,
> {
  private readonly deps: WorkspaceAgentsControllerDeps<Entry>;
  constructor(deps: WorkspaceAgentsControllerDeps<Entry>) {
    this.deps = deps;
  }

  private getSelection() {
    return Settings.state(this.deps.repoState, WORKSPACE_AGENTS_KEY);
  }

  private getHidden() {
    return Settings.state(this.deps.repoState, HIDDEN_CUSTOM_AGENTS_KEY);
  }

  getDefaultTeamId() {
    return Settings.state(this.deps.globalState, ACTIVE_TEAM_ID_KEY);
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
    return Effect.map(this.resolveStoredSelection(), ({ effectiveSelection }) =>
      effectiveSelection.kind === 'team' ? effectiveSelection.teamId : null,
    );
  }

  /** The agents this workspace shows: its selection over the catalog, and
   *  the custom agents it does not list. */
  readonly visible = Effect.fn('WorkspaceAgentsController.visible')(
    { self: this },
    function* () {
      const { identifiers } = yield* this.resolveStoredSelection();
      const hidden = yield* this.getHidden();
      const agents = this.deps.getAgents();
      if (identifiers === undefined) return visibleAgents(hidden, agents);
      const { entries } = this.resolveIdentifiers(identifiers);
      return [
        ...entries,
        ...unlistedCustomAgents(hidden, agents, entries.map(agentKeyOf)),
      ];
    },
  );

  /** Return the effective stored identifiers, including unavailable members. */
  getEnabledAgentKeys() {
    return Effect.flatMap(this.resolveStoredSelection(), (resolved) =>
      Effect.map(this.getHidden(), (hidden) =>
        this.selectionKeys(resolved, hidden),
      ),
    );
  }

  readonly snapshot = Effect.fn('WorkspaceAgentsController.snapshot')(
    { self: this },
    function* () {
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
    },
  );

  /** The keys a resolved selection enables, the custom agents it does not
   *  list included; `undefined` for every agent. */
  private selectionKeys(
    { effectiveSelection, identifiers }: ResolvedSelection,
    hidden: readonly string[],
  ) {
    if (identifiers === undefined) return undefined;
    // A custom selection already stores keys, so only an `all`/team selection
    // has names left to resolve; the kind is the same for every identifier.
    const keys =
      effectiveSelection.kind === 'custom'
        ? [...new Set(identifiers)]
        : this.resolveIdentifiers(identifiers).keys;
    const unlisted = unlistedCustomAgents(hidden, this.deps.getAgents(), keys);
    return [...keys, ...unlisted.map(agentKeyOf)];
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
  private readonly resolveSelection = Effect.fn(
    'WorkspaceAgentsController.resolveSelection',
  )(
    { self: this },
    function* (
      selection: WorkspaceAgentsSelection,
    ): Effect.fn.Return<ResolvedSelection, StateReadFailed> {
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
    },
  );

  /**
   * A change decided from the stored selection, written with the hidden
   * list and `keys` in one store step. The selection's resolution (a team's
   * members, the default team) is read before the step, so a selection
   * another writer stores in between is decided again; the step reads the
   * hidden list and `keys` itself. `change` answers the next values, or
   * `undefined` to write nothing.
   */
  private changeFromSelection(
    keys: readonly string[],
    change: (
      selection: WorkspaceAgentsSelection,
      resolved: ResolvedSelection,
      current: Readonly<Record<string, unknown>>,
    ) => Result.Result<
      Readonly<Record<string, unknown>> | undefined,
      StateReadFailed
    >,
  ): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
    return Effect.gen({ self: this }, function* () {
      const selection = yield* this.getSelection();
      const resolved = yield* this.resolveSelection(selection);
      return yield* this.deps.repoState.modify(
        [SELECTION, HIDDEN, ...keys],
        (current) => {
          // None: another writer stored the selection after the read.
          if (
            JSON.stringify(decodedSelection(current[SELECTION])) !==
            JSON.stringify(selection)
          )
            return Result.succeed([Option.none()] as const);
          return Result.map(change(selection, resolved, current), (next) =>
            next === undefined
              ? ([Option.some(undefined)] as const)
              : ([Option.some(undefined), next] as const),
          );
        },
      );
    }).pipe(
      Effect.repeat({
        times: SELECTION_CHANGE_ATTEMPTS - 1,
        until: Option.isSome,
      }),
      Effect.flatMap(
        Option.match({
          onSome: () => Effect.void,
          onNone: () =>
            Effect.fail(
              new StateWriteFailed({
                key: SELECTION,
                message:
                  'The workspace agents selection kept changing while this change was written; try again.',
                cause: undefined,
              }),
            ),
        }),
      ),
    );
  }

  /**
   * Store the selection this workspace runs, with the hidden list it
   * implies, in one store step. A team is stored by reference, so its
   * members re-resolve on every read and a member missing today activates
   * once it appears; a team the workspace has none of is rejected. A custom
   * list records its choices, and `all` shows the hidden custom agents again.
   */
  readonly select = Effect.fn('WorkspaceAgentsController.select')(
    { self: this },
    function* (selection: WorkspaceAgentsSelection) {
      if (selection.kind === 'team') yield* this.requireTeam(selection.teamId);
      const agents = this.deps.getAgents();
      const stored = storedSelection(
        selection.kind === 'custom'
          ? { kind: 'custom', agentKeys: [...new Set(selection.agentKeys)] }
          : selection,
      );
      yield* this.deps.repoState.modify([SELECTION, HIDDEN], (current) => {
        const hidden: Result.Result<unknown, StateReadFailed> =
          selection.kind === 'custom'
            ? Result.map(storedHidden(current[HIDDEN]), (keys) =>
                withCustomChoices(keys, agents, selection.agentKeys),
              )
            : Result.succeed(selection.kind === 'all' ? [] : current[HIDDEN]);
        return Result.map(
          hidden,
          (next) =>
            [undefined, { [SELECTION]: stored, [HIDDEN]: next }] as const,
        );
      });
    },
  );

  /** Fails for a team the workspace has none of. */
  private requireTeam(teamId: string) {
    return Effect.filterOrFail(
      this.teamMembers(teamId),
      (members) => members !== undefined,
      () =>
        new InvalidAgentTeamError({ message: `Unknown agent team: ${teamId}` }),
    );
  }

  /** Turn agents of one source on or off: the selection becomes the custom
   *  list it now shows, unless no agent changed. */
  setAgentEnabled(input: {
    readonly source: AgentSource;
    readonly name: string | readonly string[];
    readonly enabled: boolean;
  }): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return this.changeFromSelection([], (_selection, resolved, current) => {
      const agents = this.deps.getAgents();
      const shown = readableHidden(current[HIDDEN]);
      const target = [
        ...(this.selectionKeys(resolved, shown) ??
          visibleAgents(shown, agents).map(agentKeyOf)),
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
      if (target.length === before) return Result.succeed(undefined);
      return Result.map(storedHidden(current[HIDDEN]), (hidden) => ({
        [SELECTION]: storedSelection({ kind: 'custom', agentKeys: target }),
        [HIDDEN]: withCustomChoices(hidden, agents, target),
      }));
    });
  }

  /**
   * Remove team `teamId` from the app's saved teams (`teams.key`, changed by
   * `teams.remove`) in the step that changes the selection: a workspace
   * running it keeps its current members as a custom selection.
   */
  removeTeamPreset(
    teamId: string,
    teams: {
      readonly key: string;
      readonly remove: (
        stored: unknown,
      ) => Result.Result<unknown, StateReadFailed>;
    },
  ): Effect.Effect<void, StateWriteFailed | StateReadFailed> {
    return this.changeFromSelection(
      [teams.key],
      (selection, resolved, current) =>
        Result.map(teams.remove(current[teams.key]), (saved) => {
          const next: Record<string, unknown> = {
            ...current,
            [teams.key]: saved,
          };
          if (selection.kind === 'team' && selection.teamId === teamId) {
            const keys = this.selectionKeys(
              resolved,
              readableHidden(current[HIDDEN]),
            );
            next[SELECTION] = storedSelection(
              keys === undefined
                ? { kind: 'all' }
                : { kind: 'custom', agentKeys: keys },
            );
          }
          return next;
        }),
    );
  }

  /** The team an inheriting workspace runs, or none for `undefined`; a team
   *  the workspace has none of is rejected. The app decides which teams may
   *  be a default. */
  setDefaultTeam(teamId: string | undefined) {
    const write = this.deps.globalState.update(ACTIVE_TEAM_ID_KEY.key, teamId);
    return teamId === undefined
      ? write
      : Effect.andThen(this.requireTeam(teamId), write);
  }
}
