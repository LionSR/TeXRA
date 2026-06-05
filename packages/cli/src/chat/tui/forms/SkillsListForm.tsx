// `/skills` form. It lists discoverable runtime skills from the same source
// registry that feeds prompt
// injection instead of rediscovering paths from the UI layer.

import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';

import { readCliRuntimeSkills, skillListRecord } from '@cli/runtime/skills';

import { KeyHints } from '../ui/KeyHints';
import { Select, type SelectItem } from '../ui/Select';
import { CompactFormKeyHints, FormFrame } from './_shared/FormFrame';
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
  readonly onClose: () => void;
}

export function formatSkillDescriptionForTui(skill: SourcedSkill): string {
  const record = skillListRecord(skill);
  return `${record.sourceLabel} · ${record.description}`;
}

export function skillSelectItemsForTui(
  skills: readonly SourcedSkill[],
): SelectItem<string>[] {
  return skills.map((skill) => {
    const record = skillListRecord(skill);
    return {
      value: record.path,
      label: record.name,
      description: formatSkillDescriptionForTui(skill),
    };
  });
}

function skillImportIssueSummary(issueCount: number): string | undefined {
  if (issueCount === 0) return undefined;
  return `${issueCount} import issue${issueCount === 1 ? '' : 's'}`;
}

export function skillsSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
  readonly hasIssues: boolean;
}): SelectWindowSize {
  return computeSelectWindowSize({
    availableRows: args.availableRows,
    itemCount: args.itemCount,
    chromeRows: args.hasIssues ? 6 : 5,
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

  if (loading) {
    return (
      <FormFrame color="cyan" title="/skills" showCloseHint={false}>
        <Spinner label="Loading skills..." />
      </FormFrame>
    );
  }

  if (error) {
    return (
      <FormFrame color="red" title="/skills - error" showCloseHint={false}>
        <Text>{error}</Text>
      </FormFrame>
    );
  }

  const skills = data?.skills ?? [];
  const issueSummary = skillImportIssueSummary(data?.errors.length ?? 0);

  if (skills.length === 0) {
    return (
      <FormFrame color="yellow" title="/skills" showCloseHint={false}>
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
      <FormFrame color="cyan" title="/skills" showCloseHint={false}>
        <Text dimColor wrap="truncate-end">
          Discoverable skills.
        </Text>
        {issueSummary ? <Text dimColor>{issueSummary}</Text> : null}
        <Select
          items={items}
          maxVisibleItems={1}
          showOverflow={false}
          onSelect={props.onClose}
          onCancel={props.onClose}
        />
        <CompactFormKeyHints
          primary={{ key: '1-9/a-z/Enter', action: 'close' }}
        />
      </FormFrame>
    );
  }

  return (
    <FormFrame color="cyan" title="/skills" showCloseHint={false}>
      <Text dimColor>Discoverable skills from configured sources.</Text>
      {issueSummary ? <Text dimColor>{issueSummary}</Text> : null}
      <Select
        items={items}
        maxVisibleItems={selectWindow.maxVisibleItems}
        showOverflow={selectWindow.showOverflow}
        onSelect={props.onClose}
        onCancel={props.onClose}
      />
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'close' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}
