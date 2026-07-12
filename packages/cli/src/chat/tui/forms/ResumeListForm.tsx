// `/resume` form. It lists recent executions that can be continued from the
// current chat TUI.

import { Box, Text } from 'ink';

import {
  listCliHistoryEntries,
  resumableCliHistoryEntries,
  type CliHistoryEntry,
} from '@cli/runtime/history';
import { formatCliHistoryResumeSummary } from '@cli/runtime/historyLabels';
import type { ExecutionId } from '@shared/schemas';

import { COLOR_WARNING } from '../ui/colors';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import { FormFrame, renderAsyncListFormTransient } from './_shared/FormFrame';
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
  return `${entry.timestamp}; ${formatCliHistoryResumeSummary(entry)}`;
}

export function ResumeListForm(props: ResumeListFormProps): React.JSX.Element {
  const { data, loading, error } = useAsyncListForm<readonly CliHistoryEntry[]>(
    {
      load: async () =>
        resumableCliHistoryEntries(await listCliHistoryEntries()).slice(0, 50),
      onClose: props.onClose,
      isEmpty: (entries) => entries.length === 0,
    },
  );

  const transient = renderAsyncListFormTransient({
    loading,
    error,
    title: '/resume',
    loadingLabel: 'Loading execution history...',
  });
  if (transient) return transient;

  const entries = data ?? [];
  if (entries.length === 0) {
    return (
      <FormFrame color={COLOR_WARNING} title="/resume">
        <Text>No resumable sessions found.</Text>
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
    <FormFrame title="/resume" showCloseHint={false}>
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
    </FormFrame>
  );
}
