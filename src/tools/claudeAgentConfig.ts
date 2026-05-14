// Local imports - agent config
import { platform } from '@platform/platform';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { getWorkspaceState } from '@agent/core/stateStore';
import { WorkspaceStateKey } from '@common/state/stateKeys';
import { lookupApiKey, apiKeyEnvName } from '@model/apiProviders';
import { buildAgentWorkspaceOptions } from './agentWorkspaceOptions';
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
// Model — defaults to Opus 4.7; users can override per-call or via workspace state
// ============================================================================

/** Default Claude model passed to the Agent SDK. */
export const CLAUDE_AGENT_DEFAULT_MODEL: ClaudeAgentModel = 'claude-opus-4-7';

export function parseClaudeAgentModel(raw: string): ClaudeAgentModel {
  return (CLAUDE_AGENT_MODELS as readonly string[]).includes(raw)
    ? (raw as ClaudeAgentModel)
    : CLAUDE_AGENT_DEFAULT_MODEL;
}

export function getClaudeAgentModel(): ClaudeAgentModel {
  const raw = getWorkspaceState().get<string>(
    WorkspaceStateKey.CLAUDE_AGENT_MODEL,
    CLAUDE_AGENT_DEFAULT_MODEL,
  );
  return parseClaudeAgentModel(raw);
}

// ============================================================================
// Permission mode
// ============================================================================

const PERMISSION_MODE_DEFAULT: ClaudeAgentPermissionMode = 'acceptEdits';

export function parseClaudeAgentPermissionMode(
  raw: string,
): ClaudeAgentPermissionMode {
  return (CLAUDE_AGENT_PERMISSION_MODES as readonly string[]).includes(raw)
    ? (raw as ClaudeAgentPermissionMode)
    : PERMISSION_MODE_DEFAULT;
}

export function getClaudeAgentPermissionMode(): ClaudeAgentPermissionMode {
  const raw = getWorkspaceState().get<string>(
    WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
    PERMISSION_MODE_DEFAULT,
  );
  return parseClaudeAgentPermissionMode(raw);
}

// ============================================================================
// Effort — adaptive thinking depth hint passed via `effort` SDK option
// ============================================================================

const EFFORT_DEFAULT: ClaudeAgentEffort = 'high';

export function parseClaudeAgentEffort(raw: string): ClaudeAgentEffort {
  return (CLAUDE_AGENT_EFFORT_LEVELS as readonly string[]).includes(raw)
    ? (raw as ClaudeAgentEffort)
    : EFFORT_DEFAULT;
}

export function getClaudeAgentEffort(): ClaudeAgentEffort {
  const raw = getWorkspaceState().get<string>(
    WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
    EFFORT_DEFAULT,
  );
  return parseClaudeAgentEffort(raw);
}

// ============================================================================
// Auth env — pulls ANTHROPIC_API_KEY from secrets if set
// ============================================================================

/**
 * Build the env block passed to the Claude Code subprocess.
 *
 * Resolution order matches user expectations:
 *   1. Workspace-managed secret (Settings → API Keys → Anthropic) wins, so
 *      a key set in TeXRA "just works."
 *   2. Otherwise we leave `ANTHROPIC_API_KEY` and `CLAUDE_CODE_OAUTH_TOKEN`
 *      alone — the CLI handles them itself, and if neither is set it falls
 *      back to the `~/.claude/` config produced by `claude login`.
 *
 * The SDK identifies itself in the User-Agent via CLAUDE_AGENT_SDK_CLIENT_APP.
 */
export async function buildClaudeAgentEnv(): Promise<NodeJS.ProcessEnv> {
  const env: NodeJS.ProcessEnv = { ...process.env };

  const managed = await lookupApiKey(platform().secrets, 'anthropic').catch(
    () => undefined,
  );
  if (managed) {
    env[apiKeyEnvName('anthropic')] = managed;
  }

  env.CLAUDE_AGENT_SDK_CLIENT_APP = 'texra';
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
