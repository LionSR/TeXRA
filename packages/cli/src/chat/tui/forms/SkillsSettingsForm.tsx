import { Text } from 'ink';

import {
  ActiveSkillSourceScopeSchema,
  stateSettingByKey,
  type ActiveSkillSourceScope,
  type SkillDisplayItem,
} from '@shared/schemas';
import type { SettingsStores } from '@shared/config/settingsAccess';
import { readSetting } from '@shared/config/settingsAccess';
import { applyStateSettingUpdate } from '@shared/settingsView/handlers/stateSettingWrite';
import { WorkspaceStateKey } from '@shared/state/stateKeys';
import { loadRuntimeSkillDisplay } from '@skills/runtimeSkills';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { setTransientNotice } from '../state/cliState';
import { AsyncListForm } from './_shared/ListForm';

type SkillToggle =
  | { readonly kind: 'source'; readonly scope: ActiveSkillSourceScope }
  | { readonly kind: 'skill'; readonly name: string };

interface SkillsSettingsData {
  readonly skills: SkillDisplayItem[];
  readonly disabledNames: string[];
  readonly disabledScopes: ActiveSkillSourceScope[];
  readonly issueCount: number;
}

interface SkillsSettingsFormProps {
  readonly availableRows?: number;
  readonly stores: SettingsStores;
  readonly onClose: () => void;
}

function requireSetting(key: string) {
  const entry = stateSettingByKey(key);
  if (!entry) throw new Error(`Missing skill setting: ${key}`);
  return entry;
}

async function loadSkillsSettings(
  stores: SettingsStores,
): Promise<SkillsSettingsData> {
  const disabledNames = readSetting(
    requireSetting(WorkspaceStateKey.DISABLED_SKILLS),
    stores,
    'cli',
  ) as string[];
  const disabledScopes = readSetting(
    requireSetting(WorkspaceStateKey.DISABLED_SKILL_SOURCES),
    stores,
    'cli',
  ) as ActiveSkillSourceScope[];
  const result = await loadRuntimeSkillDisplay({
    names: disabledNames,
    scopes: disabledScopes,
  });
  return {
    skills: result.skills,
    disabledNames,
    disabledScopes,
    issueCount: result.issues.length,
  };
}

function toggleDisabled<T>(
  values: readonly T[],
  value: T,
  currentlyDisabled: boolean,
): T[] {
  return currentlyDisabled
    ? values.filter((candidate) => candidate !== value)
    : [...new Set([...values, value])];
}

export function SkillsSettingsForm(
  props: SkillsSettingsFormProps,
): React.JSX.Element {
  return (
    <AsyncListForm<SkillsSettingsData, SkillToggle>
      title="/config · Skills"
      loadingLabel="Loading skills..."
      load={() => loadSkillsSettings(props.stores)}
      items={(data) => [
        ...ActiveSkillSourceScopeSchema.options.map((scope) => ({
          value: { kind: 'source' as const, scope },
          label: `Source: ${scope}`,
          description: data.disabledScopes.includes(scope)
            ? 'disabled'
            : 'enabled',
        })),
        ...data.skills.map((skill) => ({
          value: { kind: 'skill' as const, name: skill.name },
          label: skill.name,
          description: `${skill.label} · ${skill.enabled ? 'enabled' : 'disabled'} · ${skill.description}`,
        })),
      ]}
      availableRows={props.availableRows}
      description={<Text dimColor>Toggle skills for this project.</Text>}
      detailFor={(data) =>
        data.issueCount > 0 ? (
          <Text dimColor>{data.issueCount} skill load issues</Text>
        ) : undefined
      }
      detailRowsFor={(data) => (data.issueCount > 0 ? 1 : 0)}
      action="toggle"
      showTransientCloseHint={false}
      onSelect={(toggle, { data, reload }) => {
        const key =
          toggle.kind === 'source'
            ? WorkspaceStateKey.DISABLED_SKILL_SOURCES
            : WorkspaceStateKey.DISABLED_SKILLS;
        const current =
          toggle.kind === 'source' ? data.disabledScopes : data.disabledNames;
        const value = toggle.kind === 'source' ? toggle.scope : toggle.name;
        const next = toggleDisabled(current, value, current.includes(value));
        void applyStateSettingUpdate(key, next, {
          host: 'cli',
          stores: props.stores,
        })
          .then((result) => {
            if (result.kind !== 'applied') {
              throw new Error(`Could not update skills (${result.kind}).`);
            }
            reload();
          })
          .catch((error: unknown) => setTransientNotice(toErrorMessage(error)));
      }}
      onCancel={props.onClose}
    />
  );
}
