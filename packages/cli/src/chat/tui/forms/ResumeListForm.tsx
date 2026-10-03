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
import {
  formatCliHistoryAgentLabel,
  formatCliHistorySubject,
} from '@cli/runtime/historyLabels';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { RunId } from '@shared/schemas';

import { AsyncListForm } from './_shared/ListForm';

interface ResumeListFormProps {
  /**
   * The session the history listing reads. Ink components run no Effect, so
   * the process session arrives as a prop from the surface that opened the form.
   */
  readonly session: SessionHandle;
  /** The process runtime the listing runs on, from the same surface. */
  readonly runtime: ProcessRuntime;
  readonly availableRows?: number;
  readonly onSelect: (value: RunId) => void;
  readonly onClose: () => void;
}

/** A task goes by its title: the user's, else the model's, else what it is
 *  about; the id stays for `texra resume <id>` and never labels a row. */
function resumeEntryLabel(entry: CliHistoryEntry): string {
  const title = entry.description?.replaceAll(/\s+/g, ' ').trim();
  return (
    title || formatCliHistorySubject(entry, formatCliHistoryAgentLabel(entry))
  );
}

function resumeEntryDescription(entry: CliHistoryEntry): string {
  return `${entry.timestamp} · ${entry.status} · ${formatCliHistoryAgentLabel(entry)}`;
}

export function ResumeListForm(props: ResumeListFormProps): React.JSX.Element {
  return (
    <AsyncListForm<readonly CliHistoryEntry[], RunId>
      title="/resume"
      loadingLabel="Loading history..."
      load={() =>
        Effect.map(
          listCliHistoryEntries(Effect.succeed(props.session)),
          listResumableCliHistoryEntries,
        )
      }
      runtime={props.runtime}
      items={(entries) =>
        entries.map((entry) => ({
          value: entry.id,
          label: resumeEntryLabel(entry),
          description: resumeEntryDescription(entry),
        }))
      }
      availableRows={props.availableRows}
      description={<Text dimColor>Choose a task to continue.</Text>}
      emptyMessage="Nothing to resume yet. Tasks appear here once you start one."
      selectMarginTop={1}
      action="resume"
      onSelect={props.onSelect}
      onCancel={props.onClose}
    />
  );
}
