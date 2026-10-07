/**
 * How a plugin answers "is my dependency available": the checks a plugin
 * value carries (`Plugin.availability`), the services and inputs they read,
 * and the one failure they raise. The probes an app builds them from are its
 * own (TeXRA's: `@texra/tools/availabilityProbes`).
 */

// Third-party imports
import { Data, Effect, type FileSystem } from 'effect';

// Local imports
import type { Secrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { SecretsFailed } from '@texra-ai/llm';

import type { HttpClient } from 'effect/http';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

/**
 * The one failure of this module's probes: the native binary lookup a CLI's
 * probe runs could not answer. An SDK that will not import is a dashboard
 * message, not a failure; the localhost request the Zotero probe makes folds
 * its own failures to `false`; and a tool that is simply not installed is
 * `check` answering `false`.
 */
export class ToolProbeFailed extends Data.TaggedError('ToolProbeFailed')<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

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
  check: () => Effect.succeed(true),
};

/**
 * The asking workspace, carried into a plugin's probe as data rather than read
 * from an ambient scope: the folder the GitHub plugin asks whether it is a git
 * repository, the configuration the Zotero plugin reads its port from, and the
 * host the Lean plugin asks whether it drives Lean through the editor: three
 * fields of the roots every caller of the availability surface opened.
 */
export type ToolProbeInputs = Pick<
  WorkspaceRoots,
  'workspace' | 'config' | 'host'
>;

/**
 * How a plugin with an external dependency answers "is it available": an
 * optional shared `probe` whose result the availability layer caches and
 * hands back to `check` (availability), `statusLabel` (dashboard badge) and
 * `detailCheck` (the line below the description).
 */
export interface ToolAvailabilityChecks<R = ToolProbeServices> {
  /**
   * Optional shared probe result passed to check/status/detail callbacks.
   * Takes the asking workspace as data — the GitHub plugin's probe asks whether
   * that folder is a git repository (#12421), the Zotero plugin's reads its port
   * out of that workspace's configuration.
   */
  readonly probe?: (
    inputs: ToolProbeInputs,
  ) => Effect.Effect<unknown, ToolProbeError, R>;
  /** Returns true if the external dependency is available. */
  readonly check: (
    probeResult?: unknown,
  ) => Effect.Effect<boolean, ToolProbeError, R>;
  /** Optional detailed status string resolved at check time (shown below description). */
  readonly detailCheck?: (
    probeResult?: unknown,
  ) => Effect.Effect<string | undefined, ToolProbeError, R>;
  /** Optional short status label for the dashboard badge. */
  readonly statusLabel?: (
    probeResult?: unknown,
  ) => Effect.Effect<string | undefined, ToolProbeError, R>;
  /**
   * The secret-store keys this plugin's answer reads. A committed write to any
   * of them (`credentialChanged`) re-probes every open workspace, so a plugin
   * gated on a credential declares it here instead of each host naming it.
   */
  readonly reprobeOnSecrets?: readonly string[];
}
