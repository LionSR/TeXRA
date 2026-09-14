// `/resume` form. It lists recent executions that can be continued from the
// current chat TUI.

import { Text } from 'ink';

import { Effect } from 'effect';

import type { SessionHandle } from '@agent/runtime';
import {
  listCliHistoryEntries,
  listResumableCliHistoryEntries,
  type CliHistoryEntry,
} from '@cli/runtime/history';
import { formatCliHistoryResumeSummary } from '@cli/runtime/historyLabels';
import type { RunId } from '@shared/schemas';

import { AsyncListForm } from './_shared/ListForm';

interface ResumeListFormProps {
  /**
   * The session the history listing reads. Ink components run no Effect, so
   * the process session arrives as a prop from the surface that opened the form.
   */
  readonly session: SessionHandle;
  readonly availableRows?: number;
  readonly onSelect: (value: RunId) => void;
  readonly onClose: () => void;
}

function resumeEntryDescription(entry: CliHistoryEntry): string {
  return `${entry.timestamp}; ${formatCliHistoryResumeSummary(entry)}`;
}

export function ResumeListForm(props: ResumeListFormProps): React.JSX.Element {
  return (
    <AsyncListForm<readonly CliHistoryEntry[], RunId>
      title="/resume"
      loadingLabel="Loading history..."
      load={async () =>
        listResumableCliHistoryEntries(
          await listCliHistoryEntries(Effect.succeed(props.session)),
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
