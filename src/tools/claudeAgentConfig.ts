// Node imports
import { createHash } from 'node:crypto';
import { access } from 'node:fs/promises';
import * as path from 'node:path';

// Third-party imports
import { Effect } from 'effect';
import { execa } from 'execa';

// Local imports
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { hostPort } from '@common/hostPort';
import { createLog } from '@logger/logUtils';
import { exposeApiKey, lookupApiKey, apiKeyEnvName } from '@model/apiProviders';
import { platform } from '@platform/platform';
import type {
  ClaudeAgentEffort,
  ClaudeAgentModel,
  ClaudeAgentPermissionMode,
} from '@shared/schemas';
import {
  AgentCategory,
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  parseClaudeAgentEffort,
  parseClaudeAgentModel,
  parseClaudeAgentPermissionMode,
} from '@shared/schemas';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { toErrorMessage } from '@utils/errors/errorMessage';
import { safeHomedir } from '@utils/system/platformPaths';

// Local file imports
import { createEnumStateGetter } from './support/enumConfig';
import { CLAUDE_AGENT_NAME } from './claudeAgentShared';

const log = createLog('claudeAgent');

// ============================================================================
// Model — defaults to Sonnet 5; users can override per-call or via workspace state
// ============================================================================

export const getClaudeAgentModel: () => ClaudeAgentModel =
  createEnumStateGetter(
    WorkspaceStateKey.CLAUDE_AGENT_MODEL,
    CLAUDE_AGENT_DEFAULT_MODEL,
    parseClaudeAgentModel,
  );

// ============================================================================
// Permission mode
// ============================================================================

export const getClaudeAgentPermissionMode: () => ClaudeAgentPermissionMode =
  createEnumStateGetter(
    WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
    CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
    parseClaudeAgentPermissionMode,
  );

// ============================================================================
// Effort — adaptive thinking depth hint passed via `effort` SDK option
// ============================================================================

export const getClaudeAgentEffort: () => ClaudeAgentEffort =
  createEnumStateGetter(
    WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
    CLAUDE_AGENT_DEFAULT_EFFORT,
    parseClaudeAgentEffort,
  );

// ============================================================================
// Auth env — pulls ANTHROPIC_API_KEY from secrets if set
// ============================================================================

/**
 * True when `CLAUDE_CODE_OAUTH_TOKEN` is set in `env`. Exported so callers
 * that only need the env-var check (e.g. display-only status strings) don't
 * have to read `process.env` directly in VS Code-free zones.
 */
export function hasClaudeCodeOauthToken(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return !!env.CLAUDE_CODE_OAUTH_TOKEN;
}

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
 * `env` and `currentPlatform` are injectable for testability; home-directory
 * resolution goes through `safeHomedir()` (mockable via `node:os`).
 */
const hasClaudeOauthCredential = Effect.fn('hasClaudeOauthCredential')(
  function* (
    env: NodeJS.ProcessEnv = process.env,
    currentPlatform: NodeJS.Platform = process.platform,
  ): Effect.fn.Return<boolean, never> {
    if (hasClaudeCodeOauthToken(env)) return true;

    const configDir = resolveClaudeConfigDir(env.CLAUDE_CONFIG_DIR);
    // Raw node:fs/promises, not platform().fs: FileSystemProvider
    // (@platform/interfaces) exposes no access/existence-check primitive, only
    // `stat`, which would need this same failure branch for a not-found error
    // — so routing through it buys nothing for this single boolean check.
    const credentialFileExists = yield* Effect.tryPromise({
      try: () => access(path.join(configDir, '.credentials.json')),
      catch: (error) => error,
    }).pipe(
      Effect.as(true),
      // access(F_OK) succeeds when the file exists regardless of its read
      // permissions, so an error means the file is absent or the path is not
      // traversable. Neither case is a usable credential.
      Effect.catch(() => Effect.succeed(false)),
    );
    if (credentialFileExists) return true;

    if (currentPlatform === 'darwin') {
      for (const probe of claudeKeychainCredentialProbes(configDir)) {
        const exitCode = yield* Effect.tryPromise({
          try: () =>
            execa('security', probe, {
              stdio: 'ignore',
              timeout: 1000,
              reject: false,
            }),
          catch: (error) => error,
        }).pipe(
          Effect.map((result) => result.exitCode),
          // Not found / `security` unavailable — try the next known service name.
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (exitCode === 0) return true;
      }
    }

    return false;
  },
);

function resolveClaudeConfigDir(configDirInput: string | undefined): string {
  const homeDir = safeHomedir() ?? '/nonexistent';
  const configDir = configDirInput?.trim();
  if (!configDir) return path.join(homeDir, '.claude');
  if (configDir === '~') return homeDir;
  if (configDir.startsWith('~/') || configDir.startsWith('~\\')) {
    return path.join(homeDir, configDir.slice(2));
  }
  return configDir;
}

function claudeKeychainCredentialProbes(configDir: string): string[][] {
  const normalizedConfigDir = path.resolve(configDir);
  const usesDefaultConfigDir =
    normalizedConfigDir === path.resolve(resolveClaudeConfigDir(undefined));
  const configDirHash = createHash('sha256')
    .update(normalizedConfigDir)
    .digest('hex');
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
export const buildClaudeAgentEnv = Effect.fn('buildClaudeAgentEnv')(function* (
  options: { platform?: NodeJS.Platform } = {},
): Effect.fn.Return<NodeJS.ProcessEnv, never> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'texra';
  env.CLAUDE_CODE_ENABLE_TODO_TOOLS = '1';
  const oauthToken = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauthToken) {
    env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  } else {
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
  }

  const apiKeyVar = apiKeyEnvName('anthropic');

  // 1. OAuth wins: drop any inherited API key so it can't out-prioritize the
  //    OAuth credential, and skip injecting the managed secret entirely.
  if (
    yield* hasClaudeOauthCredential(env, options.platform ?? process.platform)
  ) {
    delete env[apiKeyVar];
    return env;
  }

  // 2. Preserve an explicit env key rather than overriding it with the secret.
  if (env[apiKeyVar]) return env;

  // 3. Fall back to the Settings-managed secret. An unreadable secret store
  //    leaves the subprocess with no credential at all, so say so rather than
  //    letting it surface as an opaque "Invalid API key" from Claude Code.
  const managed = yield* hostPort(() =>
    lookupApiKey(platform().secrets, 'anthropic'),
  ).pipe(
    Effect.catch((error: unknown) => {
      log.warn(
        `Failed to read the managed Anthropic API key: ${toErrorMessage(error)}`,
      );
      return Effect.succeed(undefined);
    }),
  );
  if (managed) {
    env[apiKeyVar] = exposeApiKey(managed);
  }

  return env;
});

// ============================================================================
// Synthetic execution metadata for child streams
// ============================================================================

export function buildClaudeAgentConfig(prompt: string): AgentConfig {
  return AgentConfigSchema.parse({
    agent: CLAUDE_AGENT_NAME,
    // Fabricated label, not a routed model: Claude Code drives its own model.
    model: 'claude',
    instruction: prompt,
    agentCategory: AgentCategory.ToolUse,
  });
}
