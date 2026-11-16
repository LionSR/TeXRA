// `/skills` form. It lists discoverable runtime skills from the same source
// registry that feeds prompt injection and builds activation payloads from the
// shared runtime formatter instead of duplicating skill wiring in the UI layer.

import { Text } from 'ink';
import { Effect } from 'effect';

import {
  Skills,
  type EnabledSkill,
  type SkillLoadIssue,
} from '@texra-ai/harness/host';
import { formatResultCount, joinFacts } from '@texra-ai/harness/schemas';
import type { SelectItem } from '@cli/tui/ui/Select';
import { readCliSkillsOffNotice } from '@cli/runtime/skills';

import { AsyncListForm } from './_shared/ListForm';
import { useChatProcess } from '../chatProcess';

interface SkillsListFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: SkillActivation) => void;
  readonly onClose: () => void;
}

export interface SkillActivation {
  readonly name: string;
  readonly activationPrompt: string;
}

interface SkillsListData {
  readonly skills: readonly EnabledSkill[];
  readonly issues: readonly SkillLoadIssue[];
  readonly offHint: string | undefined;
}

function skillSelectItemsForTui(
  skills: readonly EnabledSkill[],
): SelectItem<SkillActivation>[] {
  return skills.map(({ display, activation }) => ({
    value: { name: display.name, activationPrompt: activation },
    label: display.name,
    description: joinFacts([display.label, display.description]),
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
    <AsyncListForm<SkillsListData, SkillActivation>
      title="/skills"
      loadingLabel="Loading skills..."
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
      emptyMessage="No skills yet. Add one under .texra/skills in this workspace or in your home directory, then reopen /skills."
      emptyShowCloseHint={false}
      action="activate"
      showTransientCloseHint={false}
      onSelect={props.onSelect}
      onCancel={props.onClose}
    />
  );
}
