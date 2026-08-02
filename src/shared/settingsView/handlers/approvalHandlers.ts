/**
 * Approval settings handlers shared between desktop and extension hosts.
 *
 * Builds the approval-and-safety outbound message from workspace state and
 * applies updates from inbound messages. Both hosts hold the same workspace
 * state shape — the only host-specific dependency is the bash-approval flag,
 * which lives in `ConfigProvider` rather than workspace state.
 *
 * The legacy global-scope bash-approval migration lives in
 * `@controllers/settingsView/BashApprovalGlobalMigration` — it is a stateful,
 * host-triggered one-shot workflow (not a pure message builder), so it
 * belongs with host-neutral orchestration rather than here.
 */
import type { ConfigProvider } from '@platform/interfaces';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { DEFAULT_TOOL_PATH_PROTECTION_ENABLED } from '@shared/schemas/stateSettings';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import type { UpdateApprovalAndSafetySettingsMessage } from '@shared/schemas/settingsViewMessages';
import {
  BASH_APPROVAL_CONFIG_KEY,
  CLAUDE_AGENT_DEFAULT_EFFORT,
  CLAUDE_AGENT_DEFAULT_MODEL,
  CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
  CODEX_APPROVAL_POLICY_DEFAULT,
  CODEX_REASONING_EFFORT_DEFAULT,
  CODEX_SANDBOX_MODE_DEFAULT,
  parseClaudeAgentEffort,
  parseClaudeAgentModel,
  parseClaudeAgentPermissionMode,
  parseCodexApprovalPolicy,
  parseCodexReasoningEffort,
  parseCodexSandboxMode,
} from '@shared/schemas/agentCliSettings';
import type { SettingsStatePorts } from '@shared/settingsView/types';

export interface ApprovalHandlerPorts extends SettingsStatePorts {
  readonly config: ConfigProvider;
}

export function buildApprovalSettingsMessage(
  ports: ApprovalHandlerPorts,
): UpdateApprovalAndSafetySettingsMessage {
  const { workspaceState, config } = ports;

  // Read a workspace-state string (with default) and parse it to its enum.
  function read<T>(
    key: WorkspaceStateKey,
    fallback: string,
    parse: (raw: string) => T,
  ): T {
    return parse(workspaceState.get<string>(key, fallback));
  }

  return {
    command: SETTINGS_VIEW_COMMANDS.UPDATE_APPROVAL_SETTINGS,
    bashApprovalEnabled: config.get<boolean>(BASH_APPROVAL_CONFIG_KEY, true),
    toolPathProtectionEnabled: workspaceState.get<boolean>(
      WorkspaceStateKey.TOOL_PATH_PROTECTION_ENABLED,
      DEFAULT_TOOL_PATH_PROTECTION_ENABLED,
    ),
    codexSandboxMode: read(
      WorkspaceStateKey.CODEX_SANDBOX_MODE,
      CODEX_SANDBOX_MODE_DEFAULT,
      parseCodexSandboxMode,
    ),
    codexReasoningEffort: read(
      WorkspaceStateKey.CODEX_REASONING_EFFORT,
      CODEX_REASONING_EFFORT_DEFAULT,
      parseCodexReasoningEffort,
    ),
    codexApprovalPolicy: read(
      WorkspaceStateKey.CODEX_APPROVAL_POLICY,
      CODEX_APPROVAL_POLICY_DEFAULT,
      parseCodexApprovalPolicy,
    ),
    claudeAgentModel: read(
      WorkspaceStateKey.CLAUDE_AGENT_MODEL,
      CLAUDE_AGENT_DEFAULT_MODEL,
      parseClaudeAgentModel,
    ),
    claudeAgentPermissionMode: read(
      WorkspaceStateKey.CLAUDE_AGENT_PERMISSION_MODE,
      CLAUDE_AGENT_DEFAULT_PERMISSION_MODE,
      parseClaudeAgentPermissionMode,
    ),
    claudeAgentEffort: read(
      WorkspaceStateKey.CLAUDE_AGENT_EFFORT,
      CLAUDE_AGENT_DEFAULT_EFFORT,
      parseClaudeAgentEffort,
    ),
  };
}

