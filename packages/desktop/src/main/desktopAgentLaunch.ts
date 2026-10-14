import { Effect } from 'effect';

import type { RequestOpenFilePayload } from '@shared/schemas';
import { selectAutoOpenFinalOutput } from '@texra/agent/output/selectAutoOpenFinalOutput';
import {
  createExternalLocation,
  createRunStorageLocation,
  createWorkspaceLocation,
} from '@utils/files/fileLocation';
import type { RunEndResult } from '@texra-ai/harness';
import type { AgentConfig } from '@texra-ai/harness/schemas';
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
      let location: RequestOpenFilePayload['location'];
      if (output.location === 'workspace') {
        location = createWorkspaceLocation(
          output.absolutePath,
          output.relativePath,
        );
      } else if (output.location === 'runStorage') {
        location = createRunStorageLocation(
          output.absolutePath,
          output.relativePath,
          result.runId,
        );
      } else {
        location = createExternalLocation(output.absolutePath);
      }
      yield* present.emit(
        'requestOpenFile',
        { location, preserveFocus: false },
        { replayWhenAttached: true },
      );
    });
