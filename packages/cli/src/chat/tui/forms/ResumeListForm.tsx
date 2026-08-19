// `/resume` form. It lists recent executions that can be continued from the
// current chat TUI.

import { Text } from 'ink';

import {
  listCliHistoryEntries,
  resumableCliHistoryEntries,
  RESUME_LIST_LIMIT,
  type CliHistoryEntry,
} from '@cli/runtime/history';
import { formatCliHistoryResumeSummary } from '@cli/runtime/historyLabels';
import type { ExecutionId } from '@shared/schemas';

import { AsyncListForm } from './_shared/ListForm';

export interface ResumeListFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: ExecutionId) => void;
  readonly onClose: () => void;
}

export function resumeEntryDescription(entry: CliHistoryEntry): string {
  return `${entry.timestamp}; ${formatCliHistoryResumeSummary(entry)}`;
}

export function ResumeListForm(props: ResumeListFormProps): React.JSX.Element {
  return (
    <AsyncListForm<readonly CliHistoryEntry[], ExecutionId>
      title="/resume"
      loadingLabel="Loading history..."
      load={async () =>
        resumableCliHistoryEntries(await listCliHistoryEntries()).slice(
          0,
          RESUME_LIST_LIMIT,
        )
      }
      items={(entries) =>
        entries.map((entry) => ({
          value: entry.id,
          label: entry.id,
          description: resumeEntryDescription(entry),
        }))
      }
      availableRows={props.availableRows}
      description={<Text dimColor>Choose a previous session to continue.</Text>}
      emptyMessage="Nothing to resume yet. Sessions appear here once you run an agent."
      selectMarginTop={1}
      action="resume"
      onSelect={props.onSelect}
      onCancel={props.onClose}
    />
  );
}
