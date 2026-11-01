/**
 * How a plugin answers "is my dependency available": the checks a plugin
 * value carries (`Plugin.availability`), the services and inputs they read,
 * and the one failure they raise. The probes an app builds them from are its
 * own.
 */

// Third-party imports
import { Effect, type FileSystem, Schema } from 'effect';

// Local imports
import type { Secrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { SecretsFailed } from '@texra-ai/llm';

import type { HttpClient } from 'effect/http';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * The one failure of this module's probes: the native binary lookup a CLI's
 * probe runs could not answer. An SDK that will not import is a dashboard
 * message, not a failure; a localhost request a probe makes folds its own
 * failures to `false`; and a tool that is simply not installed is
 * `check` answering `false`.
 */
export class ToolProbeFailed extends Schema.TaggedError<ToolProbeFailed>()(
  'ToolProbeFailed',
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** What a plugin's availability callbacks may fail with. */
export type ToolProbeError = ToolProbeFailed | SecretsFailed;

// ============================================================
// Type
// ============================================================

/**
 * The process services a plugin's availability callbacks read: provider
 * credentials, the HTTP client a localhost probe requests through, the
 * spawner every probe runs its child processes on, and the filesystem the
 * CLI binary probes look in. All four are `ProcessServices` arms, so every
 * caller of the availability surface already holds them. A plugin's probe
 * may also read its own process services (`definePlugin`), which it is
 * served while its layer is up; what its host passes it (an editor's
 * extensions) it closes over.
 */
export type ToolProbeServices =
  Secrets | FileSystem.FileSystem | HttpClient.HttpClient | ChildProcessSpawner;

/** A plugin that is probed but needs nothing installed: always available. */
export const ALWAYS_AVAILABLE: ToolAvailabilityChecks = {
  check: () => Effect.succeed({ available: true }),
};

/**
 * The asking workspace, carried into a plugin's probe as data rather than read
 * from an ambient scope: the folder a probe asks whether it is a git
 * repository and the configuration a probe reads a port from: two fields of
 * the roots every caller of the availability surface opened.
 */
export type ToolProbeInputs = Pick<WorkspaceRoots, 'workspace' | 'config'>;

/**
 * How a plugin with an external dependency answers "is it available": one
 * check returns availability and its dashboard explanation from the same
 * observations. The availability layer owns caching, refresh and deadlines.
 */
export interface ToolAvailabilityChecks<R = ToolProbeServices> {
  /**
   * Check the asking workspace and return its availability with an optional
   * short badge and explanation. A failed optional detail belongs here:
   * log its cause and retain the availability already established.
   */
  readonly check: (inputs: ToolProbeInputs) => Effect.Effect<
    {
      readonly available: boolean;
      readonly statusLabel?: string;
      readonly statusDetail?: string;
    },
    ToolProbeError,
    R
  >;
  /**
   * The secret-store keys this plugin's answer reads. A committed write to any
   * of them (`credentialChanged`) re-probes every open workspace, so a plugin
   * gated on a credential declares it here instead of each host naming it.
   */
  readonly reprobeOnSecrets?: readonly string[];
}
