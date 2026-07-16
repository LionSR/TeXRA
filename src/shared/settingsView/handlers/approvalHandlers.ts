/**
 * Approval settings handlers shared between desktop and extension hosts.
 *
 * Builds the approval-settings outbound message from workspace state and
 * applies updates from inbound messages. Both hosts hold the same workspace
 * state shape — the only host-specific dependency is the bash-approval flag,
 * which lives in `ConfigProvider` rather than workspace state.
 */
import * as logger from '@logger/logUtils';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import type { UpdateApprovalSettingsMessage } from '@shared/schemas/settingsViewMessages';
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
import { toErrorMessage } from '@utils/errors/errorMessage';
import type { ConfigProvider, ConfigTarget } from '@platform/interfaces';

const CHANNEL = 'approvalHandlers';

export interface ApprovalHandlerPorts extends SettingsStatePorts {
  readonly config: ConfigProvider;
}

// Bash-approval gating is a security-adjacent bypass: keep it scoped per
// workspace (not global) so disabling it in one project can't silently
// disable approval everywhere else. Both hosts must reference this constant
// rather than hardcoding their own target.
export const BASH_APPROVAL_CONFIG_TARGET: ConfigTarget = 'workspace';

export function buildApprovalSettingsMessage(
  ports: ApprovalHandlerPorts,
): UpdateApprovalSettingsMessage {
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

export async function setBashApprovalEnabled(
  ports: ApprovalHandlerPorts,
  enabled: boolean,
  target: ConfigTarget,
): Promise<void> {
  await ports.config.update(BASH_APPROVAL_CONFIG_KEY, enabled, target);
}

/**
 * One-shot per-workspace migration for the legacy global-scope bash-approval
 * override (issue #7169, follow-up to #7148 / #7085).
 *
 * Before #7148, the extension host wrote `BASH_APPROVAL_CONFIG_KEY` to the
 * *global* config target. `ConfigProvider.get` resolves workspace -> global,
 * so a user who disabled bash approval before that fix still has a global
 * `false` silently bypassing approval in every workspace with no
 * workspace-level override -- with no visible signal that a stale global
 * override is still in effect for a security-adjacent setting.
 *
 * This copies a pre-existing legacy global override into the *current*
 * workspace's config (mirroring `migrateLatexConfigToStorage`'s one-shot
 * pattern) so the effective value is preserved and now shows up in the
 * Settings UI as an explicit, correctable workspace-level toggle, then
 * clears the global value so it stops silently governing every other
 * workspace. Because the legacy value was a single global scalar, only the
 * first workspace to run this migration after upgrading inherits it; any
 * workspace opened afterward falls back to the safe default (approval
 * enabled) rather than continuing to silently inherit a stale bypass --
 * the deliberate trade-off for a security-adjacent setting that can't be
 * losslessly fanned out to every workspace that might have relied on it.
 *
 * Gated by a per-workspace marker so it runs at most once per workspace,
 * and never overwrites a workspace that already has its own explicit
 * override at either the `workspace` or resource-scoped `workspaceFolder`
 * level (`texra.toolUse.requireBashApproval` is declared `resource`-scoped,
 * so post-#7148 UI writes commonly land as `workspaceFolderValue`) -- this
 * only ever acts on a value the user never got a chance to set at the new,
 * correct scope. The one-shot marker is only ever set once the legacy
 * global value has been dealt with for real: either there was none to begin
 * with, or clearing it actually succeeded. If the clear throws, the marker
 * is left unset so a later activation gets another chance to retry it,
 * rather than permanently stranding the stale global bypass.
 */
export async function migrateLegacyGlobalBashApprovalOverride(
  ports: Pick<ApprovalHandlerPorts, 'workspaceState' | 'config'>,
): Promise<void> {
  const { workspaceState, config } = ports;

  // One-shot gate, same rationale as LATEX_SETTINGS_MIGRATED: once this
  // workspace has been migrated, never run again, so a user who later
  // re-enables the global setting for some other reason doesn't get it
  // silently re-imported and re-cleared here.
  if (
    workspaceState.get<boolean>(
      WorkspaceStateKey.BASH_APPROVAL_GLOBAL_MIGRATED,
      false,
    )
  ) {
    return;
  }

  const inspection = config.inspect<boolean>(BASH_APPROVAL_CONFIG_KEY);
  const legacyGlobalValue = inspection?.globalValue;

  if (legacyGlobalValue !== undefined) {
    // `texra.toolUse.requireBashApproval` is `resource`-scoped, so an
    // existing explicit override for this workspace can land in either
    // `workspaceValue` (the pre-#7148 write path) or `workspaceFolderValue`
    // (post-#7148 UI writes, which target the open folder). Treat either as
    // "this workspace already made its own choice" and never overwrite it
    // with the legacy global value.
    const hasExplicitWorkspaceOverride =
      inspection?.workspaceValue !== undefined ||
      inspection?.workspaceFolderValue !== undefined;

    if (!hasExplicitWorkspaceOverride) {
      try {
        await config.update(
          BASH_APPROVAL_CONFIG_KEY,
          legacyGlobalValue,
          BASH_APPROVAL_CONFIG_TARGET,
        );
        logger.info(
          CHANNEL,
          `Migrated legacy global ${BASH_APPROVAL_CONFIG_KEY} override (${String(legacyGlobalValue)}) to workspace scope`,
        );
      } catch (err) {
        // Can't safely persist to workspace scope right now (e.g. no
        // workspace folder open yet -- VS Code throws on a Workspace-target
        // write with none open). Leave the global override and the marker
        // untouched so a later activation gets another chance to migrate it
        // instead of silently dropping it here.
        logger.warn(
          CHANNEL,
          `Deferring legacy global bash-approval migration: ${toErrorMessage(err)}`,
        );
        return;
      }
    }

    try {
      await config.update(BASH_APPROVAL_CONFIG_KEY, undefined, 'global');
    } catch (err) {
      // Clearing the stale global value failed -- leave the one-shot marker
      // unset so a later activation retries the clear instead of
      // permanently giving up on it. Otherwise the uncleared global `false`
      // would keep silently bypassing approval for every other,
      // not-yet-migrated workspace with no way to ever fix it.
      logger.warn(
        CHANNEL,
        `Failed to clear legacy global ${BASH_APPROVAL_CONFIG_KEY} override: ${toErrorMessage(err)}`,
      );
      return;
    }
  }

  try {
    await workspaceState.update(
      WorkspaceStateKey.BASH_APPROVAL_GLOBAL_MIGRATED,
      true,
    );
  } catch (err) {
    logger.warn(
      CHANNEL,
      `Failed to set BASH_APPROVAL_GLOBAL_MIGRATED marker: ${toErrorMessage(err)}`,
    );
  }
}

export async function setWorkspaceAgentSetting(
  ports: SettingsStatePorts,
  key: WorkspaceStateKey,
  value: string,
): Promise<void> {
  await ports.workspaceState.update(key, value);
}
