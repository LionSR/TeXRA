// Standard library imports
import * as path from 'path';

// Local imports - agent config
import { platform } from '@platform/platform';
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { getWorkspaceState } from '@agent/core/stateStore';
import { lookupApiKey, apiKeyEnvName } from '@model/apiProviders';
import { WorkspaceFS } from '@utils/files';
import {
  CLAUDE_AGENT_NAME,
  CLAUDE_AGENT_DISPLAY_MODEL,
} from './claudeAgentShared';

// ============================================================================
// Model — defaults to Opus 4.7; users can override per-call or via workspace state
// ============================================================================

/** Default Claude model passed to the Agent SDK. */
export const CLAUDE_AGENT_DEFAULT_MODEL = 'claude-opus-4-7';

const MODEL_KEY = 'texra.claudeAgentModel';

export function getClaudeAgentModel(): string {
  return getWorkspaceState().get<string>(MODEL_KEY, CLAUDE_AGENT_DEFAULT_MODEL);
}

// ============================================================================
// Permission mode
// ============================================================================

const PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
] as const;
export const CLAUDE_AGENT_PERMISSION_MODES = PERMISSION_MODES;
export type ClaudeAgentPermissionMode = (typeof PERMISSION_MODES)[number];

const PERMISSION_MODE_KEY = 'texra.claudeAgentPermissionMode';
const PERMISSION_MODE_DEFAULT: ClaudeAgentPermissionMode = 'acceptEdits';

export function parseClaudeAgentPermissionMode(
  raw: string,
): ClaudeAgentPermissionMode {
  return (PERMISSION_MODES as readonly string[]).includes(raw)
    ? (raw as ClaudeAgentPermissionMode)
    : PERMISSION_MODE_DEFAULT;
}

export function getClaudeAgentPermissionMode(): ClaudeAgentPermissionMode {
  const raw = getWorkspaceState().get<string>(
    PERMISSION_MODE_KEY,
    PERMISSION_MODE_DEFAULT,
  );
  return parseClaudeAgentPermissionMode(raw);
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
  if (managed && !env[apiKeyEnvName('anthropic')]) {
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
  const workspacePath = WorkspaceFS.getPath();
  const trimmed = workingDirectoryInput?.trim();

  if (!workspacePath) {
    return trimmed ? { cwd: trimmed } : {};
  }

  const cwd = trimmed
    ? path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(workspacePath, trimmed)
    : workspacePath;

  const resolvedWorkspacePath = path.resolve(workspacePath);
  const resolvedCwd = path.resolve(cwd);

  if (resolvedCwd === resolvedWorkspacePath) {
    return { cwd };
  }

  const relativeToWorkspace = path.relative(resolvedWorkspacePath, resolvedCwd);
  const isInsideWorkspace =
    relativeToWorkspace.length > 0 &&
    !relativeToWorkspace.startsWith('..') &&
    !path.isAbsolute(relativeToWorkspace);

  return isInsideWorkspace
    ? { cwd, additionalDirectories: [workspacePath] }
    : { cwd };
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
