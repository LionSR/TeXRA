// `/resume` form. It lists recent executions that can be continued from the
// current chat TUI.

import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';

import {
  listCliHistoryEntries,
  type CliHistoryEntry,
} from '@cli/runtime/history';
import { formatCliHistoryInputLabel } from '@cli/runtime/historyLabels';
import type { ExecutionId } from '@shared/schemas';

import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import { FormFrame } from './_shared/FormFrame';
import {
  computeSelectWindowSize,
  type SelectWindowSize,
} from './_shared/selectWindow';
import { useAsyncListForm } from './_shared/useAsyncListForm';

export interface ResumeListFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: ExecutionId) => void;
  readonly onClose: () => void;
}

export function resumeSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
}): SelectWindowSize {
  return computeSelectWindowSize({ ...args, chromeRows: 7 });
}

export function resumeEntryDescription(entry: CliHistoryEntry): string {
  const input = formatCliHistoryInputLabel(entry.inputBasename);
  return `${entry.timestamp}; ${entry.agent}; ${entry.status}; ${input}`;
}

export function ResumeListForm(props: ResumeListFormProps): React.JSX.Element {
  const { data, loading, error } = useAsyncListForm<readonly CliHistoryEntry[]>(
    {
      load: async () => (await listCliHistoryEntries()).slice(0, 50),
      onClose: props.onClose,
      isEmpty: (entries) => entries.length === 0,
    },
  );

  if (loading) {
    return (
      <FormFrame color="cyan" title="/resume">
        <Spinner label="Loading execution history..." />
      </FormFrame>
    );
  }

  if (error) {
    return (
      <FormFrame color="red" title="/resume - error">
        <Text>{error}</Text>
      </FormFrame>
    );
  }

  const entries = data ?? [];
  if (entries.length === 0) {
    return (
      <FormFrame color="yellow" title="/resume">
        <Text>No execution history found.</Text>
      </FormFrame>
    );
  }

  const selectWindow = resumeSelectWindow({
    availableRows: props.availableRows,
    itemCount: entries.length,
  });
  const items = entries.map((entry) => ({
    value: entry.id,
    label: entry.id,
    description: resumeEntryDescription(entry),
  }));

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        /resume
      </Text>
      <Text dimColor>Choose a previous session to continue.</Text>
      <Box marginTop={1}>
        <Select
          items={items}
          maxVisibleItems={selectWindow.maxVisibleItems}
          showOverflow={selectWindow.showOverflow}
          onSelect={props.onSelect}
          onCancel={props.onClose}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: '1-9/a-z/Enter', action: 'resume' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
