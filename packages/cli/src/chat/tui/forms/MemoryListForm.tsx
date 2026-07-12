// `/memory` form. It lists stored memory files and opens a preview when a
// memory is selected.

import { Box, Text } from 'ink';

import {
  CLI_MEMORY_LIST_LIMIT,
  cliMemoryItemDescription,
} from '@cli/runtime/memory';
import type { MemoryViewItem } from '@shared/schemas';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

import { COLOR_WARNING } from '../ui/colors';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import { FormFrame, renderAsyncListFormTransient } from './_shared/FormFrame';
import {
  computeSelectWindowSize,
  type SelectWindowSize,
} from './_shared/selectWindow';
import { useAsyncListForm } from './_shared/useAsyncListForm';

export interface MemoryListFormProps {
  readonly availableRows?: number;
  readonly onSelect: (storagePath: string) => void;
  readonly onClose: () => void;
}

export function memorySelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
}): SelectWindowSize {
  return computeSelectWindowSize({ ...args, chromeRows: 7 });
}

export function MemoryListForm(props: MemoryListFormProps): React.JSX.Element {
  const { data, loading, error } = useAsyncListForm<readonly MemoryViewItem[]>({
    load: async () => (await loadMemoryItems()).slice(0, CLI_MEMORY_LIST_LIMIT),
    onClose: props.onClose,
    isEmpty: (entries) => entries.length === 0,
  });

  const transient = renderAsyncListFormTransient({
    loading,
    error,
    title: '/memory',
    loadingLabel: 'Loading memories...',
  });
  if (transient) return transient;

  const items = data ?? [];
  if (items.length === 0) {
    return (
      <FormFrame color={COLOR_WARNING} title="/memory">
        <Text>No memory files found.</Text>
      </FormFrame>
    );
  }

  const selectWindow = memorySelectWindow({
    availableRows: props.availableRows,
    itemCount: items.length,
  });
  const selectItems = items.map((item) => ({
    value: item.storagePath,
    label: item.displayPath,
    description: cliMemoryItemDescription(item),
  }));

  return (
    <FormFrame title="/memory" showCloseHint={false}>
      <Text dimColor>Choose a memory to preview in the transcript.</Text>
      <Box marginTop={1}>
        <Select
          items={selectItems}
          maxVisibleItems={selectWindow.maxVisibleItems}
          showOverflow={selectWindow.showOverflow}
          onSelect={props.onSelect}
          onCancel={props.onClose}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'up/down', action: 'navigate' },
            { key: '1-9/a-z/Enter', action: 'preview' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}
