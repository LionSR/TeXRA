import { Box, Text } from 'ink';

import { type CliApiMode } from '../../../runtime/apiAccessMode';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';

export interface ApiModeFormProps {
  readonly currentMode: CliApiMode;
  readonly onSelect: (value: CliApiMode) => void;
  readonly onCancel: () => void;
}

export function ApiModeForm(props: ApiModeFormProps): React.JSX.Element {
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
