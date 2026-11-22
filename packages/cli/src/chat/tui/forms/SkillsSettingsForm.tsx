import { Text } from 'ink';
import { Effect } from 'effect';

import {
  ActiveSkillSourceScopeSchema,
  type ActiveSkillSourceScope,
  type SkillDisplayItem,
  DISABLED_SKILLS_SETTING,
  DISABLED_SKILL_SOURCES_SETTING,
  formatResultCount,
  joinFacts,
} from '@texra-ai/worldline/schemas';
import { Skills } from '@texra-ai/worldline/host';
import { Settings } from '@texra-ai/worldline/plugins';
import {
  setSkillEnabled,
  settingWriteFailure,
} from '@texra/controllers/settingsView/stateSettingWrite';
import { enabledLabel } from '@ui/copy/format';

import { AsyncListForm } from './_shared/ListForm';
import { useChatProcess } from '../chatProcess';

type SkillToggle =
  | { readonly kind: 'source'; readonly scope: ActiveSkillSourceScope }
  | { readonly kind: 'skill'; readonly name: string };

interface SkillsSettingsData {
  readonly skills: SkillDisplayItem[];
  readonly disabledNames: readonly string[];
  readonly disabledScopes: readonly ActiveSkillSourceScope[];
  readonly issueCount: number;
}

interface SkillsSettingsFormProps {
  readonly availableRows?: number;
  readonly onClose: () => void;
}

export function SkillsSettingsForm(
  props: SkillsSettingsFormProps,
): React.JSX.Element {
  const { roots } = useChatProcess();
  return (
    <AsyncListForm<SkillsSettingsData, SkillToggle>
      title="/config · Skills"
      loadingLabel="Loading skills…"
      load={() =>
        Effect.gen(function* () {
          const result = yield* Skills.display(roots);
          return {
            skills: result.skills,
            disabledNames: yield* Settings.get(roots, DISABLED_SKILLS_SETTING),
            disabledScopes: yield* Settings.get(
              roots,
              DISABLED_SKILL_SOURCES_SETTING,
            ),
            issueCount: result.issues.length,
          };
        })
      }
      items={(data) => [
        ...ActiveSkillSourceScopeSchema.literals.map((scope) => ({
          value: { kind: 'source' as const, scope },
          label: `Source: ${scope === 'interop' ? 'imported' : scope}`,
          description: enabledLabel(!data.disabledScopes.includes(scope)),
        })),
        ...data.skills.map((skill) => ({
          value: { kind: 'skill' as const, name: skill.name },
          label: skill.name,
          description: joinFacts([
            skill.label,
            enabledLabel(skill.enabled),
            skill.description,
          ]),
        })),
      ]}
      availableRows={props.availableRows}
      description={<Text dimColor>Toggle skills for this project.</Text>}
      detailFor={(data) =>
        data.issueCount > 0 ? (
          <Text dimColor>
            {formatResultCount(data.issueCount, 'skill load issue')}
          </Text>
        ) : undefined
      }
      detailRowsFor={(data) => (data.issueCount > 0 ? 1 : 0)}
      action="toggle"
      onSelect={(toggle, { data, update }) => {
        const row =
          toggle.kind === 'source'
            ? DISABLED_SKILL_SOURCES_SETTING
            : DISABLED_SKILLS_SETTING;
        const current =
          toggle.kind === 'source' ? data.disabledScopes : data.disabledNames;
        const value = toggle.kind === 'source' ? toggle.scope : toggle.name;
        update(
          Effect.flatMap(
            setSkillEnabled(row, value, current.includes(value), roots),
            (result) => {
              const failure = settingWriteFailure(result);
              return failure === undefined ? Effect.void : Effect.fail(failure);
            },
          ),
        );
      }}
      onCancel={props.onClose}
    />
  );
}
