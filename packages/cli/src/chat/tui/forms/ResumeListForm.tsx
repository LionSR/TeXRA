// `/resume` form. It lists recent execution configurations that can be
// restarted in the current chat TUI.

import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useState } from 'react';

import {
  listCliHistoryEntries,
  type CliHistoryEntry,
} from '@cli/runtime/history';
import type { ExecutionId } from '@shared/schemas';

import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';

export interface ResumeListFormProps {
  readonly availableRows?: number;
  readonly onSelect: (value: ExecutionId) => void;
  readonly onClose: () => void;
}

export function resumeSelectWindow({
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

export function resumeEntryDescription(entry: CliHistoryEntry): string {
  const input = entry.inputBasename === '-' ? 'no input' : entry.inputBasename;
  return `${entry.timestamp}; ${entry.agent}; ${entry.status}; ${input}`;
}

function ResumeFrame(props: {
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

export function ResumeListForm(props: ResumeListFormProps): React.JSX.Element {
  const [entries, setEntries] = useState<readonly CliHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((_input, key) => {
    if ((loading || error || entries.length === 0) && key.escape) {
      props.onClose();
    }
  });

  useEffect(() => {
    let cancelled = false;
    void listCliHistoryEntries()
      .then((nextEntries) => {
        if (cancelled) return;
        setEntries(nextEntries.slice(0, 50));
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
      <ResumeFrame color="cyan" title="/resume">
        <Spinner label="Loading execution history..." />
      </ResumeFrame>
    );
  }

  if (error) {
    return (
      <ResumeFrame color="red" title="/resume - error">
        <Text>{error}</Text>
      </ResumeFrame>
    );
  }

  if (entries.length === 0) {
    return (
      <ResumeFrame color="yellow" title="/resume">
        <Text>No execution history found.</Text>
      </ResumeFrame>
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
      <Text dimColor>Choose a stored execution configuration.</Text>
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
