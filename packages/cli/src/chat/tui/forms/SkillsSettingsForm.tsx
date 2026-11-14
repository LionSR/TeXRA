import { Text } from 'ink';
import { Effect } from 'effect';

import {
  ActiveSkillSourceScopeSchema,
  type ActiveSkillSourceScope,
  type SkillDisplayItem,
  DISABLED_SKILLS_SETTING,
  DISABLED_SKILL_SOURCES_SETTING,
} from '@texra-ai/harness/schemas';
import { type WorkspaceRoots } from '@texra-ai/harness';
import { Skills, type ProcessRuntime } from '@texra-ai/harness/host';
import { Settings } from '@texra-ai/harness/plugins';
import { applyStateSettingUpdate } from '@texra/controllers/settingsView/stateSettingWrite';
import { enabledLabel } from '@ui/copy/format';

import { AsyncListForm } from './_shared/ListForm';

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
  /** The session's roots: where its skills are discovered, and the setting
   *  slots their switches live in. */
  readonly roots: WorkspaceRoots;
  /**
   * The process runtime the shared write path runs on. Ink components run
   * no Effect of their own, so it arrives as a prop from `/config`.
   */
  readonly runtime: ProcessRuntime;
  readonly onClose: () => void;
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
      load={() =>
        Effect.gen(function* () {
          const { roots } = props;
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
      runtime={props.runtime}
      items={(data) => [
        ...ActiveSkillSourceScopeSchema.literals.map((scope) => ({
          value: { kind: 'source' as const, scope },
          label: `Source: ${scope}`,
          description: enabledLabel(!data.disabledScopes.includes(scope)),
        })),
        ...data.skills.map((skill) => ({
          value: { kind: 'skill' as const, name: skill.name },
          label: skill.name,
          description: `${skill.label} · ${enabledLabel(skill.enabled)} · ${skill.description}`,
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
      onSelect={(toggle, { data, update }) => {
        const key =
          toggle.kind === 'source'
            ? DISABLED_SKILL_SOURCES_SETTING.key
            : DISABLED_SKILLS_SETTING.key;
        const current =
          toggle.kind === 'source' ? data.disabledScopes : data.disabledNames;
        const value = toggle.kind === 'source' ? toggle.scope : toggle.name;
        const next = toggleDisabled(current, value, current.includes(value));
        update(
          Effect.flatMap(
            applyStateSettingUpdate(key, next, {
              host: 'cli',
              stores: props.roots,
            }),
            (result) =>
              result.kind === 'applied'
                ? Effect.void
                : Effect.fail(
                    new Error(`Could not update skills (${result.kind}).`),
                  ),
          ),
        );
      }}
      onCancel={props.onClose}
    />
  );
}
