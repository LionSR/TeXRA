/**
 * The project's agent: the one conversation a project opens on, decided here
 * for every host. It is one fact, the run id in the project's own state
 * ({@link PROJECT_AGENT_SETTING}), and a root run like any other: the harness
 * learns no new word.
 *
 * - The first message of a conversation a person starts records its run
 *   ({@link recordProjectAgent}); opening a project records nothing, so no
 *   empty run exists and no model is called before the person speaks.
 * - Every host opens the project on the recorded run ({@link projectAgent}):
 *   the GUI window selects it, bare `texra` resumes it.
 * - Start over clears the record ({@link startOver}) and deletes nothing;
 *   the next message begins the new agent.
 * - A recorded run that was deleted, or whose saved setup is gone, reads as
 *   none with a warning naming it, and the record is cleared, never
 *   repaired.
 *
 * A window with no folder has no project, so it has no agent.
 */
import { Effect, Result } from 'effect';

import type { Session, WorkspaceRoots } from '@texra-ai/worldline';
import { Settings, withLogChannel } from '@texra-ai/worldline/plugins';
import {
  programOf,
  type AgentConfig,
  type RunId,
} from '@texra-ai/worldline/schemas';
import { SETUP_AGENT_NAME } from '@texra/agent/entryAgent';
import { PROJECT_AGENT_SETTING } from '@texra/shared/settings/texraSettings';

const CHANNEL = 'ProjectAgent';

/** The project's agent as a host opens it: its run and the setup the run
 *  recorded, which a resumed chat takes up. */
export interface ProjectAgent {
  readonly runId: RunId;
  readonly config: AgentConfig;
}

/** A warning on the channel, with the failure that caused it when there is
 *  one. */
const warn = (message: string, cause?: unknown) =>
  (cause === undefined
    ? Effect.logWarning(message)
    : Effect.logWarning(message, cause)
  ).pipe(withLogChannel(CHANNEL));

/** Clear the record, logging (never failing on) a store that refuses: the
 *  run reads as none either way. */
const clear = (roots: WorkspaceRoots) =>
  Settings.reset(roots, PROJECT_AGENT_SETTING).pipe(
    Effect.catch((cause) =>
      warn("The project's agent could not be cleared.", cause),
    ),
  );

/**
 * The run `session`'s project opens on, or null: none recorded, no folder,
 * or a recorded run that is gone (warned and cleared). A read that fails
 * (the store, or a service out of reach) reads as none with a warning and
 * leaves the record, since it cannot tell a gone run from an unreachable
 * one.
 */
export const projectAgent = Effect.fn('projectAgent')(function* (
  session: Session,
): Effect.fn.Return<ProjectAgent | null> {
  const { roots } = session;
  if (roots.workspace === undefined) return null;
  const read = yield* Effect.result(
    Effect.gen(function* () {
      const runId = yield* Settings.get(roots, PROJECT_AGENT_SETTING);
      if (runId === null) return null;
      const records = session.records(runId);
      const exists = yield* records.exists;
      const config = exists ? yield* records.readConfig : null;
      return { runId, exists, config };
    }),
  );
  if (Result.isFailure(read)) {
    yield* warn(
      "The project's agent could not be read; the project opens without it.",
      read.failure,
    );
    return null;
  }
  const found = read.success;
  if (found === null) return null;
  const { runId, exists, config } = found;
  if (config !== null) return { runId, config };
  yield* warn(
    exists
      ? `The project's agent, run ${runId}, has no saved setup; the project opens without it.`
      : `The project's agent, run ${runId}, was deleted; the project opens without it.`,
  );
  yield* clear(roots);
  return null;
});

/**
 * Record `runId`, the run the first message of a conversation a person
 * started, as the project's agent. A program's run (a document task) and
 * the setup conversation are not a project's conversation, and a window
 * with no folder has no project: none of them records anything. A later
 * conversation replaces the record, so the project opens on the one the
 * person started last. A store that refuses is warned, never failed: the
 * run itself has started.
 */
export const recordProjectAgent = Effect.fn('recordProjectAgent')(function* (
  roots: WorkspaceRoots,
  runId: RunId,
  config: AgentConfig,
): Effect.fn.Return<boolean> {
  if (
    roots.workspace === undefined ||
    programOf(config) !== null ||
    config.label === SETUP_AGENT_NAME
  )
    return false;
  return yield* Settings.set(roots, PROJECT_AGENT_SETTING, runId).pipe(
    Effect.as(true),
    Effect.catch((cause) =>
      warn(
        `Run ${runId} could not be recorded as the project's agent.`,
        cause,
      ).pipe(Effect.as(false)),
    ),
  );
});

/** Start over: the project has no agent until the next conversation's first
 *  message. The old conversation stays in the history and can be resumed. */
export const startOver = (roots: WorkspaceRoots): Effect.Effect<void> =>
  roots.workspace === undefined ? Effect.void : clear(roots);
