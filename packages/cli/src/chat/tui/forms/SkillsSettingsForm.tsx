import { Text } from 'ink';
import { Effect } from 'effect';

import {
  WorkspaceStateKey,
  ActiveSkillSourceScopeSchema,
  type ActiveSkillSourceScope,
  type SkillDisplayItem,
} from '@texra-ai/harness/schemas';
import { type WorkspaceRoots } from '@texra-ai/harness';
import { Settings, Skills, type ProcessRuntime } from '@texra-ai/harness/host';
import { applyStateSettingUpdate } from '@texra/shared/settingsView/handlers/stateSettingWrite';

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
  /** The session's roots: where its skills are discovered, and the setting
   *  slots their switches live in. */
  readonly roots: WorkspaceRoots;
  /**
   * The process runtime the shared write path settles on. Ink components run
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
            disabledNames: yield* Settings.get<string[]>(
              roots,
              WorkspaceStateKey.DISABLED_SKILLS,
            ),
            disabledScopes: yield* Settings.get<ActiveSkillSourceScope[]>(
              roots,
              WorkspaceStateKey.DISABLED_SKILL_SOURCES,
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
      onSelect={(toggle, { data, update }) => {
        const key =
          toggle.kind === 'source'
            ? WorkspaceStateKey.DISABLED_SKILL_SOURCES
            : WorkspaceStateKey.DISABLED_SKILLS;
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
