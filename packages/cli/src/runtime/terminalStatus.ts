import { Effect } from 'effect';

import { InstalledPlugins, type SettingsStores } from '@texra-ai/harness/host';
import {
  RUN_OUTCOME,
  type RunId,
  type RunOutcome,
} from '@texra-ai/harness/schemas';
import { runOutcomeToCliRunStatus } from '@cli/schemas/cliOutput';

import { CliExitCode } from './exitCodes';
import type { RunEnd } from '@texra-ai/harness';
import type { CliPluginPin } from '../schemas/cliOutput';

// A type alias, not an interface: the result line types its payload as a
// loose object, which an interface (no implicit index signature) cannot meet.
type CliRunResultMetadata = {
  /** The plugins installed when this invocation started or resumed the run. */
  readonly plugins?: readonly CliPluginPin[];
  readonly workingDirectory?: string;
  readonly runDirectory?: string;
  readonly copiedOutput?: string;
  readonly copiedOutputs?: string[];
};

/** A run's stored end, named by its run, with the CLI-only metadata. */
export type CliRunResult = RunEnd & {
  readonly runId: RunId;
} & CliRunResultMetadata;

/**
 * The plugins that load as a run result names them, read the way this
 * invocation's steps read them and without their local paths. A disabled
 * plugin, or one whose current version is not trusted, contributes nothing
 * to the run, so it is not listed.
 */
export function readCliPluginPins(stores: SettingsStores) {
  return InstalledPlugins.loaded(stores).pipe(
    Effect.map((loaded) =>
      loaded.map(({ name, source, ref, commit }): CliPluginPin => ({
        name,
        source,
        ref,
        commit,
      })),
    ),
  );
}

/** Display text for a finished chat run: the last response if present,
 *  otherwise a terse status/run-id summary. */
export function toolUseResultText(result: CliRunResult): string {
  return (
    result.output.response.trim() ||
    `${runOutcomeToCliRunStatus(result.outcome)}\nRun: ${result.runId}`
  );
}

/** Map a run outcome to the CLI process exit code.
 *
 *  A denied approval gate never reaches this mapping. The gate returns feedback
 *  to the model, which routes around it, so a denial is not a run outcome at
 *  all — it has no dedicated exit code. An earlier design gave it one, which
 *  made callers that treat a nonzero exit as "did not produce a result" discard
 *  perfectly good runs; TeXRA's own PR review workflow was among them. */
export function runOutcomeExitCode(outcome: RunOutcome): CliExitCode {
  if (outcome === RUN_OUTCOME.CANCELLED) {
    return CliExitCode.Interrupted;
  }
  if (outcome === RUN_OUTCOME.FAILED) {
    return CliExitCode.AgentError;
  }
  return CliExitCode.Success;
}
