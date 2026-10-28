// `/skills` form. It lists discoverable runtime skills from the same source
// registry that feeds prompt injection and builds activation payloads from the
// shared runtime formatter instead of duplicating skill wiring in the UI layer.

import { formatResultCount } from '@texra-ai/harness/transcript';
import { Text } from 'ink';
import { Effect } from 'effect';

import { type WorkspaceRoots } from '@texra-ai/harness';
import {
  Skills,
  type EnabledSkill,
  type ProcessRuntime,
  type SkillLoadIssue,
} from '@texra-ai/harness/host';
import type { SelectItem } from '@cli/tui/ui/Select';
import { readCliSkillsOffNotice } from '@cli/runtime/skills';

import { AsyncListForm } from './_shared/ListForm';

interface SkillsListFormProps {
  readonly availableRows?: number;
  /** The session's roots: where its skills are discovered, and the setting
   *  slots that switch skills off. */
  readonly roots: WorkspaceRoots;
  /**
   * The process runtime the discovery program settles on. Ink components run
   * no Effect of their own, so it arrives as a prop from `/skills`.
   */
  readonly runtime: ProcessRuntime;
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
    description: `${display.label} · ${display.description}`,
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
  return (
    <AsyncListForm<SkillsListData, SkillActivation>
      title="/skills"
      loadingLabel="Loading skills..."
      load={() =>
        Effect.gen(function* () {
          const result = yield* Skills.enabled(props.roots);
          return {
            ...result,
            offHint: yield* readCliSkillsOffNotice(props.roots, '/config'),
          };
        })
      }
      runtime={props.runtime}
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
