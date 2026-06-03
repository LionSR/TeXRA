import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';

// Local imports - agent config
import { platform } from '@platform/platform';
import {
  AgentConfigSchema,
  type AgentConfig,
} from '@agent/core/definition/AgentConfig';
import { AgentCategory } from '@agent/core/definition/AgentDataclass';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import {
  lookupApiKey,
  lookupApiKeyOrigin,
  apiKeyEnvName,
} from '@model/apiProviders';
import { buildAgentWorkspaceOptions } from './agentWorkspaceOptions';
import { createEnumParser, createEnumStateGetter } from './support/enumConfig';
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_AGENT_DISPLAY_MODEL,
  CLAUDE_AGENT_EFFORT_LEVELS,
  CLAUDE_AGENT_MODELS,
  CLAUDE_AGENT_PERMISSION_MODES,
  type ClaudeAgentEffort,
  type ClaudeAgentModel,
  type ClaudeAgentPermissionMode,
} from './claudeAgentShared';

// ============================================================================
// Model — defaults to Sonnet 4.6; users can override per-call or via workspace state
// ============================================================================

/** Default Claude model passed to the Agent SDK. */
export const CLAUDE_AGENT_DEFAULT_MODEL: ClaudeAgentModel = 'claude-sonnet-4-6';

/**
 * Models retired from the picker that should resolve to their successor instead
 * of silently dropping to the Sonnet default. Opus 4.7 was the prior top tier,
 * so a persisted selection maps forward to Opus 4.8 to keep users on the Opus
 * tier across the bump.
 */
const RETIRED_CLAUDE_AGENT_MODELS: Readonly<Record<string, ClaudeAgentModel>> =
  {
    'claude-opus-4-7': 'claude-opus-4-8',
  };

export const parseClaudeAgentModel: (raw: string) => ClaudeAgentModel =
  createEnumParser(
    CLAUDE_AGENT_MODELS,
    CLAUDE_AGENT_DEFAULT_MODEL,
    RETIRED_CLAUDE_AGENT_MODELS,
  );

export const getClaudeAgentModel: () => ClaudeAgentModel =
  createEnumStateGetter(
    WorkspaceStateKey.CLAUDE_AGENT_MODEL,
    CLAUDE_AGENT_DEFAULT_MODEL,
    parseClaudeAgentModel,
  );

// ============================================================================
// Permission mode
// ============================================================================

const PERMISSION_MODE_DEFAULT: ClaudeAgentPermissionMode = 'acceptEdits';

export const parseClaudeAgentPermissionMode: (
  raw: string,
) => ClaudeAgentPermissionMode = createEnumParser(
  CLAUDE_AGENT_PERMISSION_MODES,
  PERMISSION_MODE_DEFAULT,
);

export const getClaudeAgentPermissionMode: () => ClaudeAgentPermissionMode =
  createEnumStateGetter(
    WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
    PERMISSION_MODE_DEFAULT,
    parseClaudeAgentPermissionMode,
  );

// ============================================================================
// Effort — adaptive thinking depth hint passed via `effort` SDK option
// ============================================================================

const EFFORT_DEFAULT: ClaudeAgentEffort = 'high';

export const parseClaudeAgentEffort: (raw: string) => ClaudeAgentEffort =
  createEnumParser(CLAUDE_AGENT_EFFORT_LEVELS, EFFORT_DEFAULT);

export const getClaudeAgentEffort: () => ClaudeAgentEffort =
  createEnumStateGetter(
    WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
    EFFORT_DEFAULT,
    parseClaudeAgentEffort,
  );

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
 * the login keychain on macOS. The macOS probe reads metadata only (no
 * `-w`/`-g`) so it never triggers a keychain access prompt; any failure is
 * swallowed and treated as "no credential."
 */
function hasClaudeOauthCredential(): boolean {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return true;

  const configDir =
    process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  if (existsSync(path.join(configDir, '.credentials.json'))) return true;

  if (process.platform === 'darwin') {
    try {
      execFileSync(
        'security',
        ['find-generic-password', '-s', 'Claude Code-credentials'],
        { stdio: 'ignore', timeout: 2000 },
      );
      return true;
    } catch {
      // Not found / `security` unavailable — fall through to "no credential."
    }
  }

  return false;
}

/**
 * Build the env block passed to the Claude Code subprocess.
 *
 * Auth resolution prefers an existing OAuth credential over a TeXRA-managed
 * API key, so a stale key saved in Settings → API Keys can never shadow a
 * working `claude login` session (the cause of spurious "Invalid API key"
 * failures):
 *   1. An explicit `ANTHROPIC_API_KEY` in the environment is already present
 *      in `env` and passes through untouched.
 *   2. A `CLAUDE_CODE_OAUTH_TOKEN` or `claude login` session is left for the
 *      CLI to use; we do NOT override it with the managed key.
 *   3. Only when no OAuth credential exists do we inject the workspace-managed
 *      secret (Settings → API Keys → Anthropic) as `ANTHROPIC_API_KEY`.
 *
 * The SDK identifies itself in the User-Agent via CLAUDE_AGENT_SDK_CLIENT_APP.
 */
export async function buildClaudeAgentEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'texra';

  const [managed, origin] = await Promise.all([
    lookupApiKey(platform().secrets, 'anthropic').catch(() => undefined),
    lookupApiKeyOrigin(platform().secrets, 'anthropic').catch(
      () => 'none' as const,
    ),
  ]);

  // Inject only the Settings-stored secret, and only when no OAuth credential
  // is available. An `env`-origin key is already in `env`; an OAuth session
  // takes precedence over the managed key.
  if (managed && origin === 'secret' && !hasClaudeOauthCredential()) {
    env[apiKeyEnvName('anthropic')] = managed;
  }

  return env;
}

// ============================================================================
// Workspace options — mirrors codex behavior so subagents can see the project
// ============================================================================

export interface ClaudeAgentWorkspaceOptions {
  cwd?: string;
  additionalDirectories?: string[];
}

/**
 * Compute the cwd + extra-roots the SDK should see.
 *
 * When the call is made from inside the workspace, the agent runs in that
 * directory but is also granted read access to the workspace root so it can
 * inspect sibling files. Out-of-workspace cwds run isolated (matches codex).
 */
export function buildClaudeAgentWorkspaceOptions(
  workingDirectoryInput?: string | null,
): ClaudeAgentWorkspaceOptions {
  const workspace = buildAgentWorkspaceOptions(workingDirectoryInput);
  const options: ClaudeAgentWorkspaceOptions = {};

  if (workspace.workingDirectory) {
    options.cwd = workspace.workingDirectory;
  }
  if (workspace.additionalDirectories) {
    options.additionalDirectories = workspace.additionalDirectories;
  }

  return options;
}

// ============================================================================
// Synthetic execution metadata for child streams
// ============================================================================

export function buildClaudeAgentConfig(prompt: string): AgentConfig {
  return AgentConfigSchema.parse({
    agent: CLAUDE_AGENT_NAME,
    model: CLAUDE_AGENT_DISPLAY_MODEL,
    instruction: prompt,
    agentCategory: AgentCategory.ToolUse,
  });
}
