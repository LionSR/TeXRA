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
  AGENT_SOURCE,
  agentKeyOf,
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
export function readAgentRosterSelection(workspaceState: StateStore) {
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

interface RosterEntry {
  readonly name: string;
  readonly source: AgentSource;
}

/** The hidden keys, read like the roster selection: a malformed value is
 *  reported and read as none. */
function readHidden(
  workspaceState: StateStore,
): Effect.Effect<Set<string>, StateReadFailed> {
  return Effect.gen(function* () {
    const raw = yield* workspaceState.get<unknown>(
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

/** The custom agents among `entries` that `listed` leaves out and the user
 *  did not hide: shown all the same. */
export function unlistedCustomAgents<Entry extends RosterEntry>(
  workspaceState: StateStore,
  entries: readonly Entry[],
  listed: ReadonlySet<string>,
): Effect.Effect<Entry[], StateReadFailed> {
  return Effect.map(readHidden(workspaceState), (hidden) =>
    entries.filter(
      (entry) =>
        entry.source === AGENT_SOURCE.CUSTOM &&
        !listed.has(agentKeyOf(entry)) &&
        !hidden.has(agentKeyOf(entry)),
    ),
  );
}

/**
 * Record which of `entries`' custom agents a written list turns on and off:
 * one it leaves out is hidden, one it names is shown again, and `'all'`
 * shows them all. The caller holds the roster's write lane.
 */
export function recordCustomChoices(
  workspaceState: StateStore,
  entries: readonly RosterEntry[],
  selection: 'all' | readonly string[],
): Effect.Effect<void, StateReadFailed | StateWriteFailed> {
  return Effect.gen(function* () {
    const hidden = yield* readHidden(workspaceState);
    const enabled = selection === 'all' ? undefined : new Set(selection);
    for (const entry of entries) {
      if (entry.source !== AGENT_SOURCE.CUSTOM) continue;
      const key = agentKeyOf(entry);
      if (enabled === undefined || enabled.has(key)) hidden.delete(key);
      else hidden.add(key);
    }
    yield* workspaceState.update(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS, [
      ...hidden,
    ]);
  });
}
