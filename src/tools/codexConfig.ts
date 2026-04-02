// Standard library imports
import * as path from 'path';

// Local imports - agent config
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { WorkspaceFS } from '@utils/files';
import { CODEX_AGENT_NAME, CODEX_DISPLAY_MODEL } from './codexShared';

// ============================================================================
// Sandbox mode config (injectable — VS Code layer sets the real getter)
// ============================================================================

export const CODEX_SANDBOX_CONFIG_KEY = 'texra.toolUse.codexSandboxMode';

export const CODEX_SANDBOX_MODES = [
  'read-only',
  'workspace-write',
  'danger-full-access',
] as const;

export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];

/** Default sandbox mode when no VS Code config getter is registered. */
const DEFAULT_SANDBOX_MODE: CodexSandboxMode = 'workspace-write';

let sandboxModeGetter: () => CodexSandboxMode = () => DEFAULT_SANDBOX_MODE;

/** Register a platform-specific getter for the configured sandbox mode. */
export function setCodexSandboxModeGetter(
  getter: () => CodexSandboxMode,
): void {
  sandboxModeGetter = getter;
}

/** Read the user-configured default sandbox mode. */
export function getCodexSandboxMode(): CodexSandboxMode {
  return sandboxModeGetter();
}

/**
 * Build synthetic execution metadata for Codex child streams.
 *
 * Codex runs outside the normal model-handler pipeline, so we provide an
 * explicit tool-use category and a stable Codex model label for the UI
 * instead of inheriting the generic AgentConfig defaults.
 */
export function buildCodexConfig(prompt: string): AgentConfig {
  return AgentConfigSchema.parse({
    agent: CODEX_AGENT_NAME,
    model: CODEX_DISPLAY_MODEL,
    instruction: prompt,
    agentCategory: AgentCategory.ToolUse,
  });
}

export interface CodexWorkspaceOptions {
  workingDirectory?: string;
  additionalDirectories?: string[];
}

/**
 * Compute Codex workspace access options.
 *
 * When no directory is provided, Codex runs from the workspace root.
 * When a subdirectory inside the workspace is provided, we still add the
 * workspace root so the agent can inspect sibling files across the project.
 * Absolute paths outside the workspace (for example a separate git worktree)
 * run in that directory without inheriting the current workspace as an
 * additional root.
 */
export function buildCodexWorkspaceOptions(
  workingDirectoryInput?: string | null,
): CodexWorkspaceOptions {
  const workspacePath = WorkspaceFS.getPath();
  const trimmed = workingDirectoryInput?.trim();

  if (!workspacePath) {
    return trimmed ? { workingDirectory: trimmed } : {};
  }

  const workingDirectory = trimmed
    ? path.isAbsolute(trimmed)
      ? trimmed
      : path.resolve(workspacePath, trimmed)
    : workspacePath;

  const resolvedWorkspacePath = path.resolve(workspacePath);
  const resolvedWorkingDirectory = path.resolve(workingDirectory);

  if (resolvedWorkingDirectory === resolvedWorkspacePath) {
    return { workingDirectory };
  }

  const relativeToWorkspace = path.relative(
    resolvedWorkspacePath,
    resolvedWorkingDirectory,
  );
  const isInsideWorkspace =
    relativeToWorkspace.length > 0 &&
    !relativeToWorkspace.startsWith('..') &&
    !path.isAbsolute(relativeToWorkspace);

  return isInsideWorkspace
    ? {
        workingDirectory,
        additionalDirectories: [workspacePath],
      }
    : { workingDirectory };
}
