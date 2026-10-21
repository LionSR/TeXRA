import { Effect } from 'effect';

import { selectAutoOpenFinalOutput } from '@texra/agent/output/selectAutoOpenFinalOutput';
import type {
  FileLocation,
  RunEndResult,
  AgentConfig,
} from '@texra-ai/harness/schemas';
import type { DesktopProject } from './desktopProjects.js';

/** What a run's output reads of the project: its roots, and where it
 *  presents. */
type LaunchProject = Pick<DesktopProject, 'roots' | 'present'>;

/** Open a settled run's final output, as a fresh launch and a resume both do. */
export const presentDesktopFinalOutput =
  ({ roots, present }: LaunchProject, config: AgentConfig) =>
  (result: RunEndResult) =>
    Effect.gen(function* () {
      const output = yield* selectAutoOpenFinalOutput(roots, config, result);
      if (!output) return;
      const { absolutePath, relativePath } = output;
      let location: FileLocation;
      if (output.location === 'workspace') {
        location = { kind: 'workspace', absolutePath, relativePath };
      } else if (output.location === 'runStorage') {
        location = {
          kind: 'runStorage',
          absolutePath,
          relativePath,
          runId: result.runId,
        };
      } else {
        location = { kind: 'external', absolutePath };
      }
      yield* present.emit(
        'requestOpenFile',
        { location, preserveFocus: false },
        { replayWhenAttached: true },
      );
    });
