/**
 * What the workspace agents keep in repository state: the workspace agents
 * selection, and the custom agents the user hid. Other processes share the
 * store, so a change to them is one `StateStore.modify` over the keys it
 * reads and writes, and the rules here are pure functions of the values that
 * step reads.
 *
 * The one default for a custom agent an agent list does not name: it is
 * shown unless the user hid it. A list is written before the agent exists,
 * so leaving it out is not a choice to hide it; turning the agent off is,
 * and records it here. The `creator` agent's new agents therefore reach the
 * selector without a separate step, and one the user turned off stays off.
 */
import { Effect, Result, Schema } from 'effect';
import {
  decodingDefault,
  AGENT_SOURCE,
  agentKeyOf,
  agentMatchesIdentifier,
  WorkspaceAgentsSelectionSchema,
  type AgentSource,
  HiddenCustomAgentKeysSchema,
  ALL_WORKSPACE_AGENTS,
  type WorkspaceAgentsSelection,
} from '@shared/schemas';

import {
  StateReadFailed,
  type StateStore,
  type StateWriteFailed,
} from '@shared/config/settings';
import type { StateKey } from '@shared/state/stateSettings';

/** How the workspace obtains its visible agents, per repository; absent is
 *  every agent. */
export const WORKSPACE_AGENTS_KEY = {
  key: 'workspaceAgents',
  slot: 'repoState',
  schema: decodingDefault(WorkspaceAgentsSelectionSchema, ALL_WORKSPACE_AGENTS),
} as const satisfies StateKey<WorkspaceAgentsSelection>;

/** The custom agents the user turned off, per repository; every other
 *  custom agent is shown, and an absent value reads as none. */
export const HIDDEN_CUSTOM_AGENTS_KEY = {
  key: 'hiddenCustomAgents',
  slot: 'repoState',
  schema: decodingDefault(HiddenCustomAgentKeysSchema, []),
} as const satisfies StateKey<readonly string[]>;

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

/**
 * The stored hidden list a write starts from. A malformed one is refused
 * and nothing is written, since a write from none would erase every stored
 * choice.
 */
export function storedHidden(
  stored: unknown,
): Result.Result<readonly string[], StateReadFailed> {
  const { key, schema } = HIDDEN_CUSTOM_AGENTS_KEY;
  return Result.mapError(
    Schema.decodeUnknownResult(schema)(stored),
    (cause) =>
      new StateReadFailed({
        key,
        message: `The hidden agents list is invalid and was not changed: ${cause.message}`,
        cause,
      }),
  );
}

/** The custom agents among `entries` that `listed` leaves out and the user
 *  did not hide: shown all the same. */
export function unlistedCustomAgents<Entry extends WorkspaceAgentEntry>(
  hidden: readonly string[],
  entries: readonly Entry[],
  listed: readonly string[],
): Entry[] {
  const hiddenKeys = new Set(hidden);
  return entries.filter(
    (entry) =>
      entry.source === AGENT_SOURCE.CUSTOM &&
      !listNames(listed, entry) &&
      !hiddenKeys.has(agentKeyOf(entry)),
  );
}

/** `entries` less the custom agents the user hid. */
export function visibleAgents<Entry extends WorkspaceAgentEntry>(
  hidden: readonly string[],
  entries: readonly Entry[],
): Entry[] {
  const custom = unlistedCustomAgents(hidden, entries, []);
  return entries.filter(
    (entry) => entry.source !== AGENT_SOURCE.CUSTOM || custom.includes(entry),
  );
}

/**
 * The hidden list once a written list turns custom agents on and off: one
 * the list leaves out is hidden, one it names is shown again. Only the
 * agents listed now change; every other stored choice stays, a key whose
 * agent is absent included, since absence (a first scan not yet published,
 * a file that no longer parses) is no removal. A deleted agent's key goes
 * where it is deleted ({@link forgetHiddenAgent}).
 */
export function withCustomChoices(
  hidden: readonly string[],
  agents: readonly WorkspaceAgentEntry[],
  selection: readonly string[],
): string[] {
  const next = new Set(hidden);
  for (const entry of agents) {
    if (entry.source !== AGENT_SOURCE.CUSTOM) continue;
    const agentKey = agentKeyOf(entry);
    if (listNames(selection, entry)) next.delete(agentKey);
    else next.add(agentKey);
  }
  return [...next];
}

/**
 * Forget the hidden choice of a custom agent the user deleted: the one
 * place that knows its removal is real. A file removed outside the app keeps
 * its key, which is harmless, until that name is deleted here or recreated
 * and chosen again.
 */
export function forgetHiddenAgent(
  repoState: StateStore,
  name: string,
): Effect.Effect<void, StateWriteFailed> {
  const key = agentKeyOf({ source: AGENT_SOURCE.CUSTOM, name });
  const hiddenKey = HIDDEN_CUSTOM_AGENTS_KEY.key;
  return repoState.modify([hiddenKey], ({ [hiddenKey]: stored }) => {
    const hidden = Schema.decodeUnknownResult(HiddenCustomAgentKeysSchema)(
      stored,
    );
    // Absent or malformed (which every read reports): nothing to
    // forget, so the stored value stays.
    return Result.succeed(
      Result.isSuccess(hidden)
        ? ([
            undefined,
            { [hiddenKey]: hidden.success.filter((k) => k !== key) },
          ] as const)
        : ([undefined] as const),
    );
  });
}
