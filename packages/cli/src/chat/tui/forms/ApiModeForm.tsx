import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import { type CliApiMode } from '@cli/runtime/apiAccessMode';
import { loadCliApiStatusLines } from '@cli/runtime/apiStatus';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import {
  CompactFormFrame,
  shouldUseCompactForm,
} from './_shared/CompactFormFrame';

export interface ApiModeFormProps {
  readonly currentMode: CliApiMode;
  readonly availableRows?: number;
  readonly onSelect: (value: CliApiMode) => void;
  readonly onCancel: () => void;
}

export function ApiModeForm(props: ApiModeFormProps): React.JSX.Element {
  const compact = shouldUseCompactForm(props.availableRows);
  const [statusLines, setStatusLines] = useState<readonly string[]>([
    'loading API status...',
  ]);

  useEffect(() => {
    if (compact) return;
    let cancelled = false;
    void loadCliApiStatusLines()
      .then((lines) => {
        if (!cancelled) setStatusLines(lines);
      })
      .catch((error: unknown) => {
        if (!cancelled) setStatusLines([String(error)]);
      });
    return () => {
      cancelled = true;
    };
  }, [compact]);

  const items = [
    {
      value: 'personal' as const,
      label: 'Personal API keys',
      description: 'use provider keys from env or TeXRA secrets',
    },
    {
      value: 'included' as const,
      label: 'Included relay',
      description: 'use TeXRA included access',
    },
  ];

  if (compact) {
    const compactItems = items.map((item) => ({
      value: item.value,
      label: item.label,
    }));
    return (
      <CompactFormFrame
        title="/api"
        description="Choose which credentials model calls should use."
        hints={[
          { key: '↑/↓', action: 'navigate' },
          { key: '1-2', action: 'select' },
        ]}
      >
        <Select
          items={compactItems}
          activeValue={props.currentMode}
          maxVisibleItems={2}
          showOverflow={false}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
      </CompactFormFrame>
    );
  }

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        /api
      </Text>
      <Text dimColor>
        Choose which credentials model calls should use. Press 1 for API keys.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {statusLines.map((line, index) => (
          <Text key={`${index}:${line}`} dimColor>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Select
          items={items}
          activeValue={props.currentMode}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: '1-2', action: 'select' },
          ]}
        />
      </Box>
    </Box>
  );
}
