// `/skills` form. It lists discoverable runtime skills from the same source
// registry that feeds prompt injection and builds activation payloads from the
// shared runtime formatter instead of duplicating skill wiring in the UI layer.

import { Text } from 'ink';

import { formatRuntimeSkillActivation } from '@skills/runtimeSkills';
import { readCliRuntimeSkills, skillListRecord } from '@cli/runtime/skills';
import { escapeText } from '@shared/utils/xmlEscape';
import { formatResultCount } from '@utils/text/stringUtils';

import { AsyncListForm } from './_shared/ListForm';
import type { SelectItem } from '../ui/Select';
import type {
  DiscoverSkillSourcesResult,
  SourcedSkill,
} from '@skills/loadSkills';

export interface SkillsListFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: SkillActivation) => void;
  readonly onClose: () => void;
}

export interface SkillActivation {
  readonly name: string;
  readonly activationPrompt: string;
}

function formatSkillDescriptionForTui(skill: SourcedSkill): string {
  const record = skillListRecord(skill);
  return `${record.sourceLabel} · ${record.description}`;
}

export function formatSkillActivationPrompt(skill: SourcedSkill): string {
  const activationInstruction = [
    `The user selected the ${escapeText(skill.skill.name)} skill.`,
    'Use these instructions for the next substantive user request.',
    'Resolve relative file references against the skill_directory.',
  ].join(' ');
  return [
    '<skill_activation>',
    activationInstruction,
    formatRuntimeSkillActivation(skill),
    '</skill_activation>',
  ].join('\n');
}

function skillActivationForTui(skill: SourcedSkill): SkillActivation {
  const record = skillListRecord(skill);
  return {
    name: record.name,
    activationPrompt: formatSkillActivationPrompt(skill),
  };
}

export function skillSelectItemsForTui(
  skills: readonly SourcedSkill[],
): SelectItem<SkillActivation>[] {
  return skills.map((skill) => {
    const record = skillListRecord(skill);
    return {
      value: skillActivationForTui(skill),
      label: record.name,
      description: formatSkillDescriptionForTui(skill),
    };
  });
}

function skillImportIssueSummary(issueCount: number): string | undefined {
  if (issueCount === 0) return undefined;
  return formatResultCount(issueCount, 'import issue');
}

function skillIssueSummaryDetail(
  result: DiscoverSkillSourcesResult,
): React.JSX.Element | undefined {
  const summary = skillImportIssueSummary(result.errors.length);
  return summary ? <Text dimColor>{summary}</Text> : undefined;
}

export function SkillsListForm(props: SkillsListFormProps): React.JSX.Element {
  return (
    <AsyncListForm<DiscoverSkillSourcesResult, SkillActivation>
      title="/skills"
      loadingLabel="Loading skills..."
      load={readCliRuntimeSkills}
      items={(result) => skillSelectItemsForTui(result.skills)}
      isEmpty={(result) => result.skills.length === 0}
      availableRows={props.availableRows}
      description={<Text dimColor>Select a skill to activate it.</Text>}
      detailFor={skillIssueSummaryDetail}
      detailRowsFor={(result) => (result.errors.length > 0 ? 1 : 0)}
      compactDetailFor={(result) => (
        <>
          <Text dimColor wrap="truncate-end">
            Select a skill to activate.
          </Text>
          {skillIssueSummaryDetail(result)}
        </>
      )}
      emptyMessage="No discoverable skills found."
      emptyShowCloseHint={false}
      action="activate"
      showTransientCloseHint={false}
      onSelect={props.onSelect}
      onCancel={props.onClose}
    />
  );
}
