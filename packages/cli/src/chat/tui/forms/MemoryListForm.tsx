// `/memory` form. It lists stored memory files and opens a preview when a
// memory is selected.

import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';

import {
  CLI_MEMORY_LIST_LIMIT,
  cliMemoryItemDescription,
} from '@cli/runtime/memory';
import type { MemoryViewItem } from '@shared/schemas';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import { FormFrame } from './_shared/FormFrame';
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

  if (loading) {
    return (
      <FormFrame color="cyan" title="/memory">
        <Spinner label="Loading memories..." />
      </FormFrame>
    );
  }

  if (error) {
    return (
      <FormFrame color="red" title="/memory - error">
        <Text>{error}</Text>
      </FormFrame>
    );
  }

  const items = data ?? [];
  if (items.length === 0) {
    return (
      <FormFrame color="yellow" title="/memory">
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
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        /memory
      </Text>
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
    </Box>
  );
}
