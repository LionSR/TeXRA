// `/tools` form. It mirrors `texra tools list` inside an active TUI session
// and toggles integrations that are marked toggleable in EXTERNAL_TOOL_DEFS.

import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useState } from 'react';

import {
  readCliToolStatuses,
  setCliToolEnabled,
  type CliToolStatusRecord,
} from '../../../runtime/tools';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';

export interface ToolsListFormProps {
  readonly availableRows?: number;
  readonly onClose: () => void;
}

interface ToolsFrameProps {
  readonly color: string;
  readonly title: string;
  readonly children: React.ReactNode;
}

function ToolsFrame(props: ToolsFrameProps): React.JSX.Element {
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
    </Box>
  );
}

function yesNo(value: boolean | null): string {
  if (value == null) return '-';
  return value ? 'yes' : 'no';
}

function toolDescription(tool: CliToolStatusRecord): string {
  const enabled = `enabled ${yesNo(tool.enabled)}`;
  const detected = `detected ${yesNo(tool.detected)}`;
  const status = tool.statusLabel ?? tool.status;
  return `${enabled}; ${detected}; ${status}`;
}

function toolsSelectWindow({
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
  const selectRows = Math.max(1, availableRows - 5);
  if (itemCount <= selectRows) {
    return { maxVisibleItems: itemCount, showOverflow: false };
  }
  if (selectRows < 3) {
    return { maxVisibleItems: selectRows, showOverflow: false };
  }
  return { maxVisibleItems: selectRows - 2, showOverflow: true };
}

export function ToolsListForm(props: ToolsListFormProps): React.JSX.Element {
  const [tools, setTools] = useState<readonly CliToolStatusRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((_input, key) => {
    if ((loading || error) && key.escape) props.onClose();
  });

  useEffect(() => {
    let cancelled = false;
    void readCliToolStatuses()
      .then((list) => {
        if (cancelled) return;
        setTools(list);
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
      <ToolsFrame color="cyan" title="/tools">
        <Spinner label="Checking tool integrations..." />
      </ToolsFrame>
    );
  }

  if (error) {
    return (
      <ToolsFrame color="red" title="/tools - error">
        <Text>{error}</Text>
      </ToolsFrame>
    );
  }

  const selectWindow = toolsSelectWindow({
    availableRows: props.availableRows,
    itemCount: tools.length,
  });
  const items = tools.map((tool) => ({
    value: tool.id,
    label: tool.name,
    description: toolDescription(tool),
    disabled: !tool.toggleable || tool.comingSoon,
  }));

  return (
    <ToolsFrame color="cyan" title="/tools">
      <Text dimColor>Toggle available external integrations.</Text>
      <Select
        items={items}
        maxVisibleItems={selectWindow.maxVisibleItems}
        showOverflow={selectWindow.showOverflow}
        onSelect={(id) => {
          const tool = tools.find((candidate) => candidate.id === id);
          if (!tool || tool.enabled == null) return;
          void setCliToolEnabled(id, !tool.enabled)
            .then(() => readCliToolStatuses())
            .then(setTools);
        }}
        onCancel={props.onClose}
      />
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'toggle' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </ToolsFrame>
  );
}
