/**
 * What the workspace agents keeps in workspace state, and the one lane its writes
 * take: the workspace agents selection, and the custom agents the user hid.
 *
 * The one default for a custom agent an agent list does not name: it is
 * shown unless the user hid it. A list (a team, or an exact custom
 * selection) is written before the agent exists, so leaving it out is not a
 * choice to hide it; turning the agent off is, and records it here. The
 * `creator` agent's new agents therefore reach the selector without a
 * separate step, and one the user turned off stays off under any team.
 */
import { Effect } from 'effect';

import {
  StateReadFailed,
  type StateStore,
  type StateWriteFailed,
} from '@platform/interfaces';
import {
  AGENT_SOURCE,
  type AgentModePreset,
  agentKeyOf,
  agentMatchesIdentifier,
  type WorkspaceAgentsSelection,
  WorkspaceAgentsSelectionSchema,
  type AgentSource,
  HiddenCustomAgentKeysSchema,
  INHERITED_WORKSPACE_AGENTS,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { Settings } from '@shared/config/settings';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';

/**
 * One write at a time per store, module-wide. The workspace agents' write is a
 * read-modify-write of one key: two selection changes that interleave would
 * let the second read the selection the first has not stored yet. The lane
 * is the store, and its lifetime is the last fiber holding or waiting on it.
 */
const workspaceWriteLanes = new Map<StateStore, PerKeyLane>();

export function serializeWorkspaceWrite<A, E>(
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
export function readWorkspaceAgentsSelection(repoState: StateStore) {
  return Settings.state(
    repoState,
    WorkspaceStateKey.WORKSPACE_AGENTS,
    WorkspaceAgentsSelectionSchema.prefault(INHERITED_WORKSPACE_AGENTS),
  );
}

interface WorkspaceAgentEntry {
  readonly name: string;
  readonly source: AgentSource;
}

/** The hidden keys. To show the agents (`read`), a malformed value is
 *  reported and read as none, as the workspace agents selection is; to
 *  change them (`modify`), it fails, since a write from none would erase
 *  every stored choice. */
function readHidden(
  repoState: StateStore,
  purpose: 'read' | 'modify',
): Effect.Effect<Set<string>, StateReadFailed> {
  const key = WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS;
  const schema = HiddenCustomAgentKeysSchema.prefault([]);
  if (purpose === 'read')
    return Effect.map(
      Settings.state(repoState, key, schema),
      (hidden) => new Set(hidden),
    );
  return Effect.flatMap(
    Settings.inspectState(repoState, key, schema),
    (stored) =>
      stored.kind === 'value'
        ? Effect.succeed(new Set(stored.value))
        : Effect.fail(
            new StateReadFailed({
              key,
              message: `The hidden agents list is invalid and was not changed: ${stored.cause}`,
              cause: stored.cause,
            }),
          ),
  );
}

/** Whether a stored list names `entry`, by the workspace agents' identity rule: a
 *  bare name (as the CLI writes) names it as its source-qualified key does. */
function listNames(
  listed: readonly string[],
  entry: WorkspaceAgentEntry,
): boolean {
  return listed.some((identifier) => agentMatchesIdentifier(entry, identifier));
}

/** The custom agents among `entries` that `listed` leaves out and the user
 *  did not hide: shown all the same. */
export function unlistedCustomAgents<Entry extends WorkspaceAgentEntry>(
  repoState: StateStore,
  entries: readonly Entry[],
  listed: readonly string[],
): Effect.Effect<Entry[], StateReadFailed> {
  return Effect.map(readHidden(repoState, 'read'), (hidden) =>
    entries.filter(
      (entry) =>
        entry.source === AGENT_SOURCE.CUSTOM &&
        !listNames(listed, entry) &&
        !hidden.has(agentKeyOf(entry)),
    ),
  );
}

/**
 * Record which custom agents a written list turns on and off: one the list
 * leaves out is hidden, one it names is shown again. Only the agents listed
 * now change; every other stored choice stays, a key whose agent is absent
 * included, since absence (a first scan not yet published, a file that no
 * longer parses) is no removal. A deleted agent's key goes where it is
 * deleted ({@link forgetHiddenAgent}). The caller holds the workspace agents' write
 * lane.
 */
export function recordCustomChoices(
  repoState: StateStore,
  agents: readonly WorkspaceAgentEntry[],
  selection: readonly string[],
): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
  return Effect.gen(function* () {
    const hidden = yield* readHidden(repoState, 'modify');
    for (const entry of agents) {
      if (entry.source !== AGENT_SOURCE.CUSTOM) continue;
      const key = agentKeyOf(entry);
      if (listNames(selection, entry)) hidden.delete(key);
      else hidden.add(key);
    }
    yield* repoState.update(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS, [
      ...hidden,
    ]);
  });
}

/**
 * Forget the hidden choice of a custom agent the user deleted: the one
 * place that knows its removal is real. A file removed outside the app keeps
 * its key, which is harmless, until that name is deleted here or recreated
 * and chosen again. Takes the workspace agents' write lane itself.
 */
export function forgetHiddenAgent(
  repoState: StateStore,
  name: string,
): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
  return serializeWorkspaceWrite(
    repoState,
    Effect.gen(function* () {
      const hidden = yield* readHidden(repoState, 'modify');
      const key = agentKeyOf({ source: AGENT_SOURCE.CUSTOM, name });
      if (!hidden.delete(key)) return;
      yield* repoState.update(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS, [
        ...hidden,
      ]);
    }),
  );
}

/** The identifiers a selection lists; `undefined` means every agent. */
export function selectedIdentifiers(
  selection: Exclude<WorkspaceAgentsSelection, { readonly kind: 'inherit' }>,
  presets: readonly AgentModePreset[],
): readonly string[] | undefined {
  if (selection.kind === 'all') return undefined;
  if (selection.kind === 'custom') return selection.agentKeys;
  const preset = presets.find((candidate) => candidate.id === selection.teamId);
  return preset?.agents;
}

/** `entries` less the custom agents the user hid. */
export function visibleAgents<Entry extends WorkspaceAgentEntry>(
  repoState: StateStore,
  entries: readonly Entry[],
): Effect.Effect<Entry[], StateReadFailed> {
  return Effect.map(unlistedCustomAgents(repoState, entries, []), (custom) =>
    entries.filter(
      (entry) => entry.source !== AGENT_SOURCE.CUSTOM || custom.includes(entry),
    ),
  );
}
