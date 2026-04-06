// Standard library imports
import * as path from 'path';

// Local imports - agent config
import { AgentConfigSchema, type AgentConfig } from '@agent/core/AgentConfig';
import { AgentCategory } from '@agent/core/AgentDataclass';
import { WorkspaceFS } from '@utils/files';
import { CODEX_AGENT_NAME, CODEX_DISPLAY_MODEL } from './codexShared';

// ============================================================================
// Model config — the Codex CLI uses short model names, not versioned API IDs
// ============================================================================

/** Short model name passed to the Codex CLI via --model. */
export const CODEX_CLI_MODEL = 'gpt-5.4';

// ============================================================================
// Injectable config factory — used for Codex settings that the VS Code layer
// provides at startup via a getter, keeping src/tools/ free of vscode imports.
// ============================================================================

interface CodexConfigSetting<T extends string> {
  readonly values: readonly T[];
  parse: (raw: string) => T;
  get: () => T;
  setGetter: (getter: () => T) => void;
}

function createCodexSetting<const T extends string>(
  values: readonly T[],
  defaultValue: NoInfer<T>,
): CodexConfigSetting<T> {
  let getter: () => T = () => defaultValue;
  return {
    values,
    parse: (raw: string): T =>
      (values as readonly string[]).includes(raw) ? (raw as T) : defaultValue,
    get: () => getter(),
    setGetter: (fn: () => T) => {
      getter = fn;
    },
  };
}

// ============================================================================
// Reasoning effort
// ============================================================================

const reasoningEffort = createCodexSetting(
  ['low', 'medium', 'high', 'xhigh'] as const,
  'high',
);

export const CODEX_REASONING_EFFORTS = reasoningEffort.values;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
export const parseCodexReasoningEffort = reasoningEffort.parse;
export const getCodexReasoningEffort = reasoningEffort.get;
export const setCodexReasoningEffortGetter = reasoningEffort.setGetter;

// ============================================================================
// Sandbox mode
// ============================================================================

const sandboxMode = createCodexSetting(
  ['read-only', 'workspace-write', 'danger-full-access'] as const,
  'workspace-write',
);

export const CODEX_SANDBOX_MODES = sandboxMode.values;
export type CodexSandboxMode = (typeof CODEX_SANDBOX_MODES)[number];
export const parseCodexSandboxMode = sandboxMode.parse;
export const getCodexSandboxMode = sandboxMode.get;
export const setCodexSandboxModeGetter = sandboxMode.setGetter;

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
