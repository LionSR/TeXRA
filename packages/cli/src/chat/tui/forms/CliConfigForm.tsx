import { cliSettingsStores } from '@cli/runtime/settingsStores';
import { applyCliGitAuthorConfig } from '@cli/runtime/gitAuthor';
import { invalidateModelOptionsCache } from '@model/computeModelOptions';
import {
  readSetting,
  resetSetting,
  writeSetting,
  type SettingsStores,
} from '@shared/config/settingsAccess';
import { CLI_STATE_SETTINGS } from '@shared/schemas/stateSettings';
import { GlobalStateKey } from '@shared/state/stateKeys';

import { AgentRosterForm } from './AgentRosterForm';
import { ConfigForm, type ConfigFormProps } from './ConfigForm';
import { ToolsListForm } from './ToolsListForm';

export interface CliConfigFormProps {
  readonly availableRows?: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
  readonly openExternalForm?: (formName: string) => void;
  readonly onApiModePersonal?: () => void | Promise<void>;
}

export interface CreateCliConfigFormPropsInput extends CliConfigFormProps {
  readonly stores: SettingsStores;
}

/**
 * Settings whose change alters model routing or picker availability, so the
 * cached model options must be recomputed (computeModelOptions reads both
 * toggles when resolving per-model routes).
 */
const MODEL_ROUTING_SETTING_KEYS: ReadonlySet<string> = new Set([
  GlobalStateKey.USE_OPENROUTER,
  GlobalStateKey.KIMI_CODE_PREFER,
]);

/**
 * Construct the canonical CLI configuration interface. Both the standalone
 * command and the in-chat form use this function, so persistence and runtime
 * side effects cannot diverge between entry points.
 */
export function createCliConfigFormProps(
  props: CreateCliConfigFormPropsInput,
): ConfigFormProps {
  const { stores } = props;
  return {
    availableRows: props.availableRows,
    entries: CLI_STATE_SETTINGS,
    readValue: (entry) => readSetting(entry, stores, 'cli'),
    writeValue: async (entry, value) => {
      await writeSetting(entry, value, stores, 'cli');
      if (entry.category === 'git') applyCliGitAuthorConfig(stores.config);
      if (MODEL_ROUTING_SETTING_KEYS.has(entry.key)) {
        invalidateModelOptionsCache();
        if (entry.key === GlobalStateKey.USE_OPENROUTER && value === true) {
          await props.onApiModePersonal?.();
        }
      }
    },
    resetValue: async (entry) => {
      await resetSetting(entry, stores, 'cli');
      if (entry.category === 'git') applyCliGitAuthorConfig(stores.config);
      if (MODEL_ROUTING_SETTING_KEYS.has(entry.key)) {
        invalidateModelOptionsCache();
      }
    },
    formLinks: [
      {
        name: 'agents',
        label: 'Agents',
        description: 'workspace roster and user default team',
      },
    ],
    formRenderers: {
      agents: (onBack) => (
        <AgentRosterForm
          availableRows={props.availableRows}
          onClose={onBack}
          onError={props.onError}
        />
      ),
      tools: (onBack) => (
        <ToolsListForm availableRows={props.availableRows} onClose={onBack} />
      ),
    },
    openForm: props.openExternalForm,
    onClose: props.onClose,
    onError: props.onError,
  };
}

/** Canonical CLI configuration form, shared by `texra config` and `/config`. */
export function CliConfigForm(props: CliConfigFormProps): React.JSX.Element {
  return (
    <ConfigForm
      {...createCliConfigFormProps({
        ...props,
        stores: cliSettingsStores(),
      })}
    />
  );
}
