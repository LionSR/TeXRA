/**
 * What the agent roster keeps in workspace state, and the one lane its writes
 * take: the roster selection, and the custom agents the user hid.
 *
 * The one default for a custom agent a roster list does not name: it is
 * shown unless the user hid it. A list (a team, or an exact custom
 * selection) is written before the agent exists, so leaving it out is not a
 * choice to hide it; turning the agent off is, and records it here. The
 * `creator` agent's new agents therefore reach the selector without a
 * separate step, and one the user turned off stays off under any team.
 */
import { Effect } from 'effect';

import { withLogChannel } from '@logger/effectLog';
import type {
  StateReadFailed,
  StateStore,
  StateWriteFailed,
} from '@platform/interfaces';
import {
  AGENT_CATEGORIES,
  AGENT_SOURCE,
  type AgentCategory,
  type AgentRosterCategorySelection,
  agentKeyOf,
  agentMatchesIdentifier,
  AgentRosterSelectionSchema,
  type AgentSource,
  HiddenCustomAgentKeysSchema,
  INHERITED_AGENT_ROSTER,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { withPerKeyLane, type PerKeyLane } from '@utils/core/perKeyQueue';

const CHANNEL = 'AgentRosterController';

/**
 * One write at a time per store, module-wide. The roster's write is a
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
export function readAgentRosterSelection(repoState: StateStore) {
  return Effect.gen(function* () {
    const raw = yield* repoState.get<unknown>(
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

interface RosterEntry {
  readonly name: string;
  readonly source: AgentSource;
}

/** The hidden keys, read like the roster selection: a malformed value is
 *  reported and read as none. */
function readHidden(
  repoState: StateStore,
): Effect.Effect<Set<string>, StateReadFailed> {
  return Effect.gen(function* () {
    const raw = yield* repoState.get<unknown>(
      WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS,
    );
    if (raw === undefined) return new Set<string>();
    const parsed = HiddenCustomAgentKeysSchema.safeParse(raw);
    if (parsed.success) return new Set(parsed.data);
    yield* Effect.logWarning(
      `Ignoring malformed hidden custom agents; showing every custom agent: ${parsed.error.message}`,
    ).pipe(withLogChannel(CHANNEL));
    return new Set<string>();
  });
}

/** Whether a stored list names `entry`, by the roster's identity rule: a
 *  bare name (as the CLI writes) names it as its source-qualified key does. */
function listNames(listed: readonly string[], entry: RosterEntry): boolean {
  return listed.some((identifier) => agentMatchesIdentifier(entry, identifier));
}

/** The custom agents among `entries` that `listed` leaves out and the user
 *  did not hide: shown all the same. */
export function unlistedCustomAgents<Entry extends RosterEntry>(
  repoState: StateStore,
  entries: readonly Entry[],
  listed: readonly string[],
): Effect.Effect<Entry[], StateReadFailed> {
  return Effect.map(readHidden(repoState), (hidden) =>
    entries.filter(
      (entry) =>
        entry.source === AGENT_SOURCE.CUSTOM &&
        !listNames(listed, entry) &&
        !hidden.has(agentKeyOf(entry)),
    ),
  );
}

/**
 * Record which custom agents the written lists turn on and off: in a
 * category `selections` names, one its list leaves out is hidden, one it
 * names is shown again, and `'all'` shows them all. Only the agents listed
 * now change; every other stored choice stays, a key whose agent is absent
 * included, since absence (a first scan not yet published, a file that no
 * longer parses) is no removal. A deleted agent's key goes where it is
 * deleted ({@link forgetHiddenAgent}). The caller holds the roster's write
 * lane.
 */
export function recordCustomChoices(
  repoState: StateStore,
  agentsOf: (category: AgentCategory) => readonly RosterEntry[],
  selections: Partial<Record<AgentCategory, AgentRosterCategorySelection>>,
): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
  return Effect.gen(function* () {
    const hidden = yield* readHidden(repoState);
    for (const category of AGENT_CATEGORIES) {
      const selection = selections[category];
      if (selection === undefined) continue;
      for (const entry of agentsOf(category)) {
        if (entry.source !== AGENT_SOURCE.CUSTOM) continue;
        const key = agentKeyOf(entry);
        if (selection === 'all' || listNames(selection, entry))
          hidden.delete(key);
        else hidden.add(key);
      }
    }
    yield* repoState.update(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS, [
      ...hidden,
    ]);
  });
}

/**
 * Forget the hidden choice of a custom agent the user deleted: the one
 * place that knows its removal is real. A file removed outside TeXRA keeps
 * its key, which is harmless, until that name is deleted here or recreated
 * and chosen again. Takes the roster's write lane itself.
 */
export function forgetHiddenAgent(
  repoState: StateStore,
  name: string,
): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
  return serializeWorkspaceWrite(
    repoState,
    Effect.gen(function* () {
      const hidden = yield* readHidden(repoState);
      const key = agentKeyOf({ source: AGENT_SOURCE.CUSTOM, name });
      if (!hidden.delete(key)) return;
      yield* repoState.update(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS, [
        ...hidden,
      ]);
    }),
  );
}
