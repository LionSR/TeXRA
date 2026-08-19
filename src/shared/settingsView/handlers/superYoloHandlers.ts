/**
 * Reliability-and-orchestration settings message builder.
 *
 * The outbound wire command remains `updateSuperYoloEnabled` for compatibility;
 * the payload is reliability tuning, orchestrator-kill permissions, and
 * subagent-detach behaviour — not a TeXRA approval-policy value.
 *
 * Reliability settings are host-specific (VS Code config-backed in the
 * extension; absent in the desktop build), so callers supply them.
 */
import { createLog } from '@logger/logUtils';
import type { ConfigProvider } from '@platform/interfaces';
import { SETTINGS_VIEW_COMMANDS } from '@shared/ipc';
import {
  CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
  CHILD_RUN_CONCURRENCY_BUDGET_SETTING,
  ChildRunConcurrencyBudgetSchema,
  type NumberSetting,
  type UpdateReliabilityAndOrchestrationMessage,
} from '@shared/schemas';
import { GlobalStateKey } from '@shared/state/stateKeys';
import type { SettingsStatePorts } from '@shared/settingsView/types';
import { toErrorMessage } from '@utils/errors/errorMessage';

const log = createLog('superYoloHandlers');

export interface ReliabilityAndOrchestrationHandlerPorts extends SettingsStatePorts {
  readonly config: ConfigProvider;
  /** Host-provided reliability settings (extension only — desktop returns []). */
  readonly getReliabilitySettings: () => NumberSetting[];
}

function readChildRunConcurrencyBudget(config: ConfigProvider): number {
  const parsed = ChildRunConcurrencyBudgetSchema.safeParse(
    config.get<unknown>(CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY),
  );
  if (parsed.success) return parsed.data;
  // Loud-read policy: a hand-edited persisted value that fails validation
  // must not silently fall back without a warning, matching the runtime
  // reader (`getValidatedConfig`). An absent key parses to the prefault and
  // never reaches this branch.
  if (config.isExplicitlySet(CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY)) {
    log.warn(
      'Ignoring invalid value for child-run concurrency budget setting',
      {
        data: {
          key: CHILD_RUN_CONCURRENCY_BUDGET_CONFIG_KEY,
          error: toErrorMessage(parsed.error),
        },
      },
    );
  }
  return CHILD_RUN_CONCURRENCY_BUDGET_SETTING.defaultValue;
}

export function buildReliabilityAndOrchestrationMessage(
  ports: ReliabilityAndOrchestrationHandlerPorts,
): UpdateReliabilityAndOrchestrationMessage {
  const { globalState } = ports;
  return {
    // Compatibility-pinned wire literal — see settingsView/data.ts.
    command: SETTINGS_VIEW_COMMANDS.UPDATE_SUPER_YOLO_ENABLED,
    reliabilitySettings: ports.getReliabilitySettings(),
    allowOrchestratorKill: globalState.get<boolean>(
      GlobalStateKey.ALLOW_ORCHESTRATOR_KILL,
      true,
    ),
    detachSubagentsOnStop: globalState.get<boolean>(
      GlobalStateKey.DETACH_SUBAGENTS_ON_STOP,
      false,
    ),
    childRunConcurrencyBudget: readChildRunConcurrencyBudget(ports.config),
  };
}
