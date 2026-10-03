/**
 * The once-per-process bootstrap that sits beside each composition root's
 * `installProcessRuntime()`, in one order for every host.
 *
 * Each composition root still installs its own process runtime — every
 * service it serves is host-specific and ESLint pins the install to the
 * roots. What surrounded that install was not host-specific at all: the VS
 * Code extension, the Electron main process and the `texra` CLI each
 * performed the same process-wide installs in three different orders, every
 * body carrying a comment claiming to mirror one of the other two. This
 * module owns that order, so the three roots cannot drift and there is one
 * place to read what a started TeXRA process has installed.
 *
 * Nothing here reads an ambient host: every step either sets a module-global,
 * registers a closure that resolves later, or forks a process-lifetime
 * subscriber on the root's runtime; the one state write takes its store as
 * an argument, and the secret cleanup uses the runtime's `Secrets`. The CLI
 * keeps its roots and lazy session private until this fallible setup has
 * succeeded, and the first-install seed below is the fallible step that
 * invariant was written for.
 *
 * What stays with the caller: the process runtime install, the
 * `WorkspaceRoots` (each host resolves its config stores differently, and the
 * CLI opens its process session over the roots before this runs), and the
 * host's shutdown: a scope whose finalizers close every session, then the
 * host's own resources, then the runtime, each host registering the
 * resources only it holds.
 */

// Third-party imports
import { Effect } from 'effect';

// Local imports
import { withLogChannel } from '@logger/effectLog';
import {
  initializeNodeRuntimeSkills,
  type NodeRuntimeSkillOptions,
} from '@platform/defaults/nodeHost';
import { installProcessHttpDispatcher } from '@platform/defaults/longRunningModelTransport';
import { Secrets } from '@platform/secrets';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import { seedDisabledToolDefaults } from '@tools/toolAvailability';
import { ToolRegistry } from '@tools/toolTable';

// Local file imports
import { installSubscriptionProbes } from './modelAccess/installSubscriptionProbes';

/** Secret names the removed TeXRA account wrote (`texra.supabase.session`,
 *  `texra.supabase.gotrue*`, `texra.auth.pendingOAuthState.<nonce>`). */
const RETIRED_ACCOUNT_SECRET_PREFIXES = [
  'texra.supabase.',
  'texra.auth.pendingOAuthState.',
];

/** The fixed names among them, deleted by name where the store cannot list
 *  its keys; only the per-nonce pending records need the listing. */
const RETIRED_ACCOUNT_SECRET_KEYS = [
  'texra.supabase.session',
  'texra.supabase.gotrue',
  'texra.supabase.gotrue-code-verifier',
];

export interface HostBootstrapInit {
  /**
   * The process roots the root just built: the global state store the
   * first-install seed writes to.
   */
  readonly roots: WorkspaceRoots;
  /** The bundled resources tree (and the CLI's flag-supplied source options). */
  readonly skills: NodeRuntimeSkillOptions;
}

/**
 * Everything a TeXRA process installs once beside its platform.
 *
 * Runs on the composition root's own process runtime: the first-install tool
 * seed is a state write, and the root that just installed that runtime is the
 * one that runs this. Its secret store is that runtime's `Secrets` service.
 */
export const bootstrapHost = Effect.fn('bootstrapHost')(function* (
  init: HostBootstrapInit,
) {
  // The environment's proxy policy for the rest of the process's HTTP
  // traffic. Model traffic carries its own transport; this is the host's
  // process, so it may set the global dispatcher an embedder's may not.
  installProcessHttpDispatcher();
  // ChatGPT / Grok subscription sign-in. Without this the model layer is
  // bring-your-own-key. See installSubscriptionProbes. The probes
  // close over the secret store, so the model layer stays secrets-free.
  const secrets = yield* Secrets;
  installSubscriptionProbes(secrets);
  // The removed TeXRA account left its Supabase session (a refresh token),
  // GoTrue's PKCE verifiers and the pending sign-in records in the secret
  // store. Delete them by name, never reading a value; once gone, the listing
  // finds nothing and this is a no-op. A store that cannot list its keys
  // (an editor without `SecretStorage.keys()`) still loses the fixed names.
  // A failure only leaves them for the next start.
  yield* secrets.listStoredKeys().pipe(
    Effect.catchIf(
      (error) => error.reason === 'enumeration-unsupported',
      () => Effect.succeed(RETIRED_ACCOUNT_SECRET_KEYS),
    ),
    Effect.map((keys) =>
      keys.filter((key) =>
        RETIRED_ACCOUNT_SECRET_PREFIXES.some((prefix) =>
          key.startsWith(prefix),
        ),
      ),
    ),
    Effect.flatMap((retired) =>
      Effect.forEach(retired, (key) => secrets.delete(key), { discard: true }),
    ),
    Effect.catchTag('SecretsFailed', (error) =>
      Effect.logWarning(
        `Could not delete the retired TeXRA account secrets: ${error.message}`,
      ).pipe(withLogChannel('hostBootstrap')),
    ),
  );
  // Project skills follow each session's workspace; only the bundle is fixed
  // here, so this is a registration rather than a scan. Tool plugins that ship
  // skills contribute them to the bundled tier; the ids cross as strings so
  // `@skills` and `@platform` take no value edge to `@tools`.
  const plugins = [...(yield* ToolRegistry).entries.values()];
  initializeNodeRuntimeSkills(
    init.skills,
    plugins.flatMap((plugin) => (plugin.skills === true ? [plugin.id] : [])),
  );
  // Seed first-install defaults (e.g. disabled tools). No-ops once
  // DISABLED_TOOLS exists, so upgrading users keep the tools they enabled.
  yield* seedDisabledToolDefaults(init.roots.globalState, plugins);
});
