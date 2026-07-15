// `/skills` form. It lists discoverable runtime skills from the same source
// registry that feeds prompt injection and builds activation payloads from the
// shared runtime formatter instead of duplicating skill wiring in the UI layer.

import { Box, Text } from 'ink';

import { formatRuntimeSkillActivation } from '@skills/runtimeSkills';
import { readCliRuntimeSkills, skillListRecord } from '@cli/runtime/skills';
import { escapeText } from '@shared/utils/xmlEscape';
import { formatResultCount } from '@utils/text/stringUtils';

import { COLOR_WARNING } from '../ui/colors';
import { KeyHints } from '../ui/KeyHints';
import { Select, type SelectItem } from '../ui/Select';
import {
  CompactFormKeyHints,
  FormFrame,
  renderAsyncListFormTransient,
} from './_shared/FormFrame';
import {
  computeSelectWindowSize,
  isCompactFormRows,
  type SelectWindowSize,
} from './_shared/selectWindow';
import { useAsyncListForm } from './_shared/useAsyncListForm';
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

export function skillsSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
  readonly hasIssues: boolean;
}): SelectWindowSize {
  return computeSelectWindowSize({
    availableRows: args.availableRows,
    itemCount: args.itemCount,
    chromeRows: args.hasIssues ? 7 : 6,
  });
}

export function SkillsListForm(props: SkillsListFormProps): React.JSX.Element {
  const { data, loading, error } = useAsyncListForm<DiscoverSkillSourcesResult>(
    {
      load: readCliRuntimeSkills,
      onClose: props.onClose,
      isEmpty: (result) => result.skills.length === 0,
    },
  );

  const transient = renderAsyncListFormTransient({
    loading,
    error,
    title: '/skills',
    loadingLabel: 'Loading skills...',
    showCloseHint: false,
  });
  if (transient) return transient;

  const skills = data?.skills ?? [];
  const issueSummary = skillImportIssueSummary(data?.errors.length ?? 0);

  if (skills.length === 0) {
    return (
      <FormFrame color={COLOR_WARNING} title="/skills" showCloseHint={false}>
        <Text>No discoverable skills found.</Text>
        {issueSummary ? <Text dimColor>{issueSummary}</Text> : null}
      </FormFrame>
    );
  }

  const selectWindow = skillsSelectWindow({
    availableRows: props.availableRows,
    itemCount: skills.length,
    hasIssues: issueSummary !== undefined,
  });
  const items = skillSelectItemsForTui(skills);

  if (isCompactFormRows(props.availableRows)) {
    return (
      <FormFrame title="/skills" showCloseHint={false}>
        <Text dimColor wrap="truncate-end">
          Select a skill to activate.
        </Text>
        {issueSummary ? <Text dimColor>{issueSummary}</Text> : null}
        <Select
          items={items}
          maxVisibleItems={1}
          showOverflow={false}
          onSelect={props.onSelect}
          onCancel={props.onClose}
        />
        <CompactFormKeyHints
          primary={{ key: '1-9/a-z/Enter', action: 'activate' }}
        />
      </FormFrame>
    );
  }

  return (
    <FormFrame title="/skills" showCloseHint={false}>
      <Text dimColor>Select a skill to activate it.</Text>
      {issueSummary ? <Text dimColor>{issueSummary}</Text> : null}
      <Select
        items={items}
        maxVisibleItems={selectWindow.maxVisibleItems}
        showOverflow={selectWindow.showOverflow}
        onSelect={props.onSelect}
        onCancel={props.onClose}
      />
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'activate' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}
