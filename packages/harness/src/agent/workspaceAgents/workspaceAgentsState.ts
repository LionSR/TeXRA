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
import { Effect, Result, Schema } from 'effect';

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

/** Run `write` in `store`'s workspace-agents write lane, after any write
 *  already queued there. */
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
export function readWorkspaceAgentsSelection(
  repoState: StateStore,
): Effect.Effect<WorkspaceAgentsSelection, StateReadFailed> {
  return Settings.state(
    repoState,
    WorkspaceStateKey.WORKSPACE_AGENTS,
    WorkspaceAgentsSelectionSchema.pipe(
      Schema.withDecodingDefault(Effect.succeed(INHERITED_WORKSPACE_AGENTS)),
    ),
  );
}

/** The stored hidden agent keys; an absent value reads as none. */
const HiddenKeysSchema = HiddenCustomAgentKeysSchema.pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

interface WorkspaceAgentEntry {
  readonly name: string;
  readonly source: AgentSource;
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
  // A malformed hidden list is reported and read as none, as the workspace
  // agents selection is.
  return Effect.map(
    Settings.state(
      repoState,
      WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS,
      HiddenKeysSchema,
    ),
    (stored) => {
      const hidden = new Set(stored);
      return entries.filter(
        (entry) =>
          entry.source === AGENT_SOURCE.CUSTOM &&
          !listNames(listed, entry) &&
          !hidden.has(agentKeyOf(entry)),
      );
    },
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
  const key = WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS;
  // One step at the store, which other processes share. A malformed stored
  // value fails and nothing is written, since a write from none would erase
  // every stored choice.
  return Effect.asVoid(
    repoState.modify(key, (stored) =>
      Result.match(Schema.decodeUnknownResult(HiddenKeysSchema)(stored), {
        onFailure: (cause) =>
          Result.fail(
            new StateReadFailed({
              key,
              message: `The hidden agents list is invalid and was not changed: ${cause.message}`,
              cause,
            }),
          ),
        onSuccess: (keys) => {
          const hidden = new Set(keys);
          for (const entry of agents) {
            if (entry.source !== AGENT_SOURCE.CUSTOM) continue;
            const agentKey = agentKeyOf(entry);
            if (listNames(selection, entry)) hidden.delete(agentKey);
            else hidden.add(agentKey);
          }
          return Result.succeed([...hidden]);
        },
      }),
    ),
  );
}

/**
 * Forget the hidden choice of a custom agent the user deleted: the one
 * place that knows its removal is real. A file removed outside the app keeps
 * its key, which is harmless, until that name is deleted here or recreated
 * and chosen again. Takes the workspace agents' write lane itself, and
 * changes the key in one step at the store, which other processes share.
 */
export function forgetHiddenAgent(
  repoState: StateStore,
  name: string,
): Effect.Effect<void, StateWriteFailed> {
  const key = agentKeyOf({ source: AGENT_SOURCE.CUSTOM, name });
  return serializeWorkspaceWrite(
    repoState,
    Effect.asVoid(
      repoState.modify(WorkspaceStateKey.HIDDEN_CUSTOM_AGENTS, (stored) => {
        const hidden = Schema.decodeUnknownResult(HiddenCustomAgentKeysSchema)(
          stored,
        );
        // Absent or malformed (which every read reports): nothing to
        // forget, so the stored value stays.
        return Result.succeed(
          Result.isSuccess(hidden)
            ? hidden.success.filter((k) => k !== key)
            : stored,
        );
      }),
    ),
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

/**
 * The one walk from stored identifiers to catalog entries. `entries` are the
 * resolved members deduplicated by key; `missing` the identifiers with no
 * entry; `keys` each identifier's canonical key, or the identifier itself
 * when it does not resolve, deduplicated in stored order.
 */
export function resolveIdentifiers<Entry extends WorkspaceAgentEntry>(
  identifiers: readonly string[],
  resolveAgent: (identifier: string) => Entry | undefined,
): { entries: Entry[]; missing: string[]; keys: string[] } {
  const entries = new Map<string, Entry>();
  const keys = new Set<string>();
  const missing: string[] = [];
  for (const identifier of identifiers) {
    const entry = resolveAgent(identifier);
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
