import { Box, Text } from 'ink';
import { useEffect, useState } from 'react';

import { type CliApiMode } from '../../../runtime/apiAccessMode';
import { loadCliApiStatusLines } from '../../../runtime/apiStatus';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';

export interface ApiModeFormProps {
  readonly currentMode: CliApiMode;
  readonly onSelect: (value: CliApiMode) => void;
  readonly onCancel: () => void;
}

export function ApiModeForm(props: ApiModeFormProps): React.JSX.Element {
  const [statusLines, setStatusLines] = useState<readonly string[]>([
    'loading API status...',
  ]);

  useEffect(() => {
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
  }, []);

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
        {statusLines.map((line) => (
          <Text key={line} dimColor>
            {line}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Select
          items={[
            {
              value: 'personal',
              label: 'Personal API keys',
              description: 'use provider keys from env or TeXRA secrets',
            },
            {
              value: 'included',
              label: 'Included relay',
              description: 'use TeXRA included access',
            },
          ]}
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
