import { applyCliGitAuthorConfig } from '@cli/runtime/gitAuthor';
import { cliSettingsStores } from '@cli/runtime/settingsStores';
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
      if (entry.key === GlobalStateKey.USE_OPENROUTER) {
        invalidateModelOptionsCache();
        if (value === true) await props.onApiModePersonal?.();
      }
    },
    resetValue: async (entry) => {
      await resetSetting(entry, stores, 'cli');
      if (entry.category === 'git') applyCliGitAuthorConfig(stores.config);
      if (entry.key === GlobalStateKey.USE_OPENROUTER) {
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
