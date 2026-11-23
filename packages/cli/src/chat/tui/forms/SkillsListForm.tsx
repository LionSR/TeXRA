// `/skills` form. It lists the enabled skills from the same source registry
// that feeds prompt injection; a selection is the skill's name, which the
// next message carries and the session renders.

import { Text } from 'ink';
import { Effect } from 'effect';

import { Skills, type SkillLoadIssue } from '@texra-ai/worldline/host';
import {
  formatResultCount,
  joinFacts,
  type SkillDisplayItem,
} from '@texra-ai/worldline/schemas';
import type { SelectItem } from '@cli/tui/ui/Select';
import { readCliSkillsOffNotice } from '@cli/runtime/skills';

import { AsyncListForm } from './_shared/ListForm';
import { useChatProcess } from '../chatProcess';

interface SkillsListFormProps {
  readonly availableRows: number;
  /** Called with the selected skill's name. */
  readonly onSelect: (name: string) => void;
  readonly onClose: () => void;
}

interface SkillsListData {
  readonly skills: readonly SkillDisplayItem[];
  readonly issues: readonly SkillLoadIssue[];
  readonly offHint: string | undefined;
}

function skillSelectItemsForTui(
  skills: readonly SkillDisplayItem[],
): SelectItem<string>[] {
  return skills.map(({ name, label, description }) => ({
    value: name,
    label: name,
    description: joinFacts([label, description]),
  }));
}

function skillIssueSummaryDetail(
  result: SkillsListData,
): React.JSX.Element | undefined {
  if (result.issues.length === 0 && result.offHint === undefined) {
    return undefined;
  }
  return (
    <>
      {result.offHint === undefined ? null : (
        <Text dimColor wrap="truncate-end">
          {result.offHint}
        </Text>
      )}
      {result.issues.length === 0 ? null : (
        <Text dimColor>
          {formatResultCount(result.issues.length, 'import issue')}
        </Text>
      )}
    </>
  );
}

export function SkillsListForm(props: SkillsListFormProps): React.JSX.Element {
  const { roots } = useChatProcess();
  return (
    <AsyncListForm<SkillsListData, string>
      title="/skills"
      loadingLabel="Loading skills…"
      load={() =>
        Effect.gen(function* () {
          const result = yield* Skills.enabled(roots);
          return {
            ...result,
            offHint: yield* readCliSkillsOffNotice(roots, '/config'),
          };
        })
      }
      items={(result) => skillSelectItemsForTui(result.skills)}
      isEmpty={(result) => result.skills.length === 0}
      availableRows={props.availableRows}
      description={<Text dimColor>Select a skill to activate it.</Text>}
      detailFor={skillIssueSummaryDetail}
      detailRowsFor={(result) =>
        (result.issues.length > 0 ? 1 : 0) +
        (result.offHint === undefined ? 0 : 1)
      }
      compactDetailFor={(result) => (
        <>
          <Text dimColor wrap="truncate-end">
            Select a skill to activate.
          </Text>
          {skillIssueSummaryDetail(result)}
        </>
      )}
      emptyMessage="No skills yet. Add one under .texra/skills in this project or in your home directory, then reopen /skills."
      action="activate"
      onSelect={props.onSelect}
      onCancel={props.onClose}
    />
  );
}
