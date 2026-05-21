// `/memory` form. It lists stored memory files and opens a preview when a
// memory is selected.

import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useState } from 'react';

import type { MemoryViewItem } from '@shared/schemas';
import { loadMemoryItems } from '@tools/memory/memoryFileSystem';

import {
  CLI_MEMORY_LIST_LIMIT,
  cliMemoryItemDescription,
} from '../../../runtime/memory';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';

export interface MemoryListFormProps {
  readonly availableRows?: number;
  readonly onSelect: (storagePath: string) => void;
  readonly onClose: () => void;
}

export function memorySelectWindow({
  availableRows,
  itemCount,
}: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
}): {
  readonly maxVisibleItems: number | undefined;
  readonly showOverflow: boolean;
} {
  if (availableRows == null) {
    return { maxVisibleItems: undefined, showOverflow: false };
  }

  const selectRows = Math.max(1, availableRows - 7);
  if (itemCount <= selectRows) {
    return { maxVisibleItems: itemCount, showOverflow: false };
  }
  if (selectRows < 3) {
    return { maxVisibleItems: selectRows, showOverflow: false };
  }
  return { maxVisibleItems: Math.max(1, selectRows - 2), showOverflow: true };
}

function MemoryFrame(props: {
  readonly color: string;
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <Box
      borderStyle="round"
      borderColor={props.color}
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color={props.color}>
        {props.title}
      </Text>
      {props.children}
      <Box marginTop={1}>
        <KeyHints
          hints={[{ key: 'Esc', action: 'close' }]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}

export function MemoryListForm(props: MemoryListFormProps): React.JSX.Element {
  const [items, setItems] = useState<readonly MemoryViewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((_input, key) => {
    if ((loading || error || items.length === 0) && key.escape) {
      props.onClose();
    }
  });

  useEffect(() => {
    let cancelled = false;
    void loadMemoryItems()
      .then((nextItems) => {
        if (cancelled) return;
        setItems(nextItems.slice(0, CLI_MEMORY_LIST_LIMIT));
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return (
      <MemoryFrame color="cyan" title="/memory">
        <Spinner label="Loading memories..." />
      </MemoryFrame>
    );
  }

  if (error) {
    return (
      <MemoryFrame color="red" title="/memory - error">
        <Text>{error}</Text>
      </MemoryFrame>
    );
  }

  if (items.length === 0) {
    return (
      <MemoryFrame color="yellow" title="/memory">
        <Text>No memory files found.</Text>
      </MemoryFrame>
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
            { key: '1-9/Enter', action: 'preview' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}
