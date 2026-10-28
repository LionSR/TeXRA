// Node imports
import { hash } from 'node:crypto';
import { access } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import * as os from 'node:os';
import { Effect } from 'effect';

// Local imports
import {
  apiKeyEnvName,
  exposeApiKey,
  lookupApiKey,
  type SecretsFailed,
} from '@texra-ai/llm';
import { Secrets, withLogChannel } from '@texra-ai/harness/host';
import { executeCommand, inheritedEnv } from '@texra-ai/harness/node';
import { ensureError } from '@texra-ai/harness/schemas';
import type { ChildProcessSpawner } from 'effect/process/ChildProcessSpawner';

const CHANNEL = 'claudeAgent';

// ============================================================================
// Auth env — pulls ANTHROPIC_API_KEY from secrets if set
// ============================================================================

/**
 * Detect an existing Claude Code OAuth credential — either the
 * `CLAUDE_CODE_OAUTH_TOKEN` env var (from `claude setup-token`) or a
 * `claude login` session (Pro/Max subscription).
 *
 * Best-effort and side-effect-free: the login session lives in
 * `${CLAUDE_CONFIG_DIR | ~/.claude}/.credentials.json` on Linux/Windows and in
 * the login keychain on macOS. The macOS probes read metadata only (no
 * `-w`/`-g`) so they never trigger a keychain access prompt; any failure is
 * swallowed and treated as "no credential."
 *
 * `env` is the environment the subprocess will get, so the answer matches
 * what Claude Code sees.
 * A home directory that cannot be resolved is logged and leaves only an
 * explicit `CLAUDE_CONFIG_DIR` to probe.
 */
const hasClaudeOauthCredential = Effect.fn('hasClaudeOauthCredential')(
  function* (
    env: NodeJS.ProcessEnv,
  ): Effect.fn.Return<boolean, never, ChildProcessSpawner> {
    if (env.CLAUDE_CODE_OAUTH_TOKEN) return true;

    const configDir = yield* resolveClaudeConfigDir(env.CLAUDE_CONFIG_DIR);
    if (configDir === undefined) return false;
    // Raw node:fs/promises, not the `FileSystem` service: `access(F_OK)` is
    // exactly this question, and the service's `exists` would need this same
    // failure branch anyway — so taking it from context buys nothing for one
    // boolean, and this check runs before any root is resolved.
    const credentialFileExists = yield* Effect.tryPromise({
      try: () => access(path.join(configDir, '.credentials.json')),
      catch: ensureError,
    }).pipe(
      Effect.as(true),
      // access(F_OK) succeeds when the file exists regardless of its read
      // permissions, so an error means the file is absent or the path is not
      // traversable. Neither case is a usable credential.
      Effect.catch(() => Effect.succeed(false)),
    );
    if (credentialFileExists) return true;

    if (process.platform === 'darwin') {
      const defaultConfigDir = yield* resolveClaudeConfigDir(undefined);
      for (const probe of claudeKeychainCredentialProbes(
        configDir,
        defaultConfigDir,
      )) {
        const { exitCode } = yield* executeCommand(['security', ...probe], {
          cwd: process.cwd(),
          settings: undefined,
          timeout: 1000,
          quiet: true,
        });
        // `quiet` also silences the spawn-failure log, and `security` is part
        // of macOS, so its absence is worth a line before reading not-found.
        if (exitCode === 127) {
          yield* Effect.logWarning(
            'The macOS `security` tool could not start; the keychain credential probe reads as not found.',
          ).pipe(withLogChannel(CHANNEL));
        }
        if (exitCode === 0) return true;
      }
    }

    return false;
  },
);

/** The home directory, or `undefined` (logged) where none resolves. */
const homeDirectory = Effect.try({
  try: () => os.homedir(),
  catch: ensureError,
}).pipe(
  Effect.catch((error) =>
    Effect.logWarning(
      `The home directory could not be resolved; a Claude Code login under it reads as not found: ${error.message}`,
    ).pipe(withLogChannel(CHANNEL), Effect.as(undefined)),
  ),
);

/** Claude Code's config directory: an explicit `CLAUDE_CONFIG_DIR` as is,
 *  else under the home directory, or `undefined` when that is unknown. */
const resolveClaudeConfigDir = Effect.fnUntraced(function* (
  configDirInput: string | undefined,
): Effect.fn.Return<string | undefined> {
  const configDir = configDirInput?.trim();
  if (configDir && configDir !== '~' && !/^~[\\/]/.test(configDir))
    return configDir;
  const homeDir = yield* homeDirectory;
  if (homeDir === undefined) return undefined;
  if (!configDir) return path.join(homeDir, '.claude');
  return configDir === '~' ? homeDir : path.join(homeDir, configDir.slice(2));
});

function claudeKeychainCredentialProbes(
  configDir: string,
  defaultConfigDir: string | undefined,
): string[][] {
  const normalizedConfigDir = path.resolve(configDir);
  const usesDefaultConfigDir =
    defaultConfigDir !== undefined &&
    normalizedConfigDir === path.resolve(defaultConfigDir);
  const configDirHash = hash('sha256', normalizedConfigDir, 'hex');
  const keychainProfiles = [normalizedConfigDir, configDirHash];
  const legacyProbes: string[][] = usesDefaultConfigDir
    ? [['find-generic-password', '-s', 'Claude Code-credentials']]
    : [];

  return [
    ...legacyProbes,
    ...keychainProfiles.flatMap((profile) => [
      [
        'find-generic-password',
        '-a',
        `${profile}-user`,
        '-s',
        `${profile}-access-token`,
      ],
      [
        'find-generic-password',
        '-a',
        `${profile}-user`,
        '-s',
        `${profile}-refresh-token`,
      ],
    ]),
  ];
}

/**
 * Build the env block passed to the Claude Code subprocess.
 *
 * Auth precedence is OAuth > env API key > managed secret:
 *
 *   1. A `CLAUDE_CODE_OAUTH_TOKEN` or `claude login` session always wins. We
 *      strip `ANTHROPIC_API_KEY` from the subprocess env so the CLI uses the
 *      OAuth credential and never inject the managed key — an API key must
 *      never out-prioritize or shadow OAuth (the cause of spurious "Invalid
 *      API key" failures).
 *   2. Otherwise an explicit `ANTHROPIC_API_KEY` inherited from the
 *      environment passes through untouched.
 *   3. Otherwise the workspace-managed secret (Settings → API Keys →
 *      Anthropic) is injected as `ANTHROPIC_API_KEY`.
 *
 * The SDK identifies itself in the User-Agent via CLAUDE_AGENT_SDK_CLIENT_APP.
 */
export const buildClaudeAgentEnv = Effect.fn('buildClaudeAgentEnv')(
  function* (): Effect.fn.Return<
    NodeJS.ProcessEnv,
    SecretsFailed,
    Secrets | ChildProcessSpawner
  > {
    const apiKeyVar = apiKeyEnvName('anthropic');
    // The other providers' keys stay out of the subprocess: what its tools
    // print comes back as a tool result. Its own Anthropic key is resolved below.
    const env: NodeJS.ProcessEnv = yield* inheritedEnv('anthropic');
    env.CLAUDE_AGENT_SDK_CLIENT_APP = 'texra';
    env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';
    const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
    if (oauthToken) {
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    } else {
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
    }

    // 1. OAuth wins: drop any inherited API key so it can't out-prioritize the
    //    OAuth credential, and skip injecting the managed secret entirely.
    if (yield* hasClaudeOauthCredential(env)) {
      delete env[apiKeyVar];
      return env;
    }

    // 2. Preserve an explicit env key rather than overriding it with the secret.
    if (env[apiKeyVar]) return env;

    // 3. Fall back to the Settings-managed secret. An unreadable secret store
    //    fails as itself: launching with no credential would surface it as an
    //    opaque "Invalid API key" from Claude Code.
    const secrets = yield* Secrets;
    const managed = yield* lookupApiKey(secrets, 'anthropic');
    if (managed) {
      env[apiKeyVar] = exposeApiKey(managed);
    }

    return env;
  },
);
