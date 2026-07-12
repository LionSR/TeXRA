import { Box, Text } from 'ink';
import { useState } from 'react';

import { type CliApiMode } from '@cli/runtime/apiAccessMode';
import { loadCliApiStatusLines } from '@cli/runtime/apiStatus';
import { useCancellableEffect } from '../state/useCancellableEffect';
import { KeyHints } from '../ui/KeyHints';
import { LoadingIndicator } from '../ui/LoadingIndicator';
import { Select } from '../ui/Select';
import { CompactFormKeyHints, FormFrame } from './_shared/FormFrame';
import { isCompactFormRows } from './_shared/selectWindow';

export interface ApiModeFormProps {
  readonly currentMode: CliApiMode;
  readonly availableRows?: number;
  readonly onSelect: (value: CliApiMode) => void;
  readonly onCancel: () => void;
}

export function ApiModeForm(props: ApiModeFormProps): React.JSX.Element {
  const [statusLines, setStatusLines] = useState<readonly string[] | null>(
    null,
  );

  useCancellableEffect(
    (isCancelled) => {
      setStatusLines(null);
      void loadCliApiStatusLines({ apiMode: props.currentMode })
        .then((lines) => {
          if (!isCancelled()) setStatusLines(lines);
        })
        .catch((error: unknown) => {
          if (!isCancelled()) setStatusLines([String(error)]);
        });
    },
    [props.currentMode],
  );

  const items = [
    {
      value: 'personal' as const,
      label: 'Personal API keys',
      description: 'use provider keys from env or TeXRA secrets',
    },
    {
      value: 'included' as const,
      label: 'Included TeXRA access',
      description: 'use TeXRA included access',
    },
  ];

  if (isCompactFormRows(props.availableRows)) {
    return (
      <FormFrame title="/api" showCloseHint={false}>
        <Select
          items={items}
          activeValue={props.currentMode}
          maxVisibleItems={items.length}
          showOverflow={false}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
        <CompactFormKeyHints primary={{ key: '1-2/Enter', action: 'select' }} />
      </FormFrame>
    );
  }

  return (
    <FormFrame title="/api" showCloseHint={false}>
      <Text dimColor>
        Choose which credentials model calls should use. Press 1 for API keys.
      </Text>
      <Box marginTop={1} flexDirection="column">
        {statusLines === null ? (
          <LoadingIndicator label="loading API status..." />
        ) : (
          statusLines.map((line, index) => (
            <Text key={`${index}:${line}`} dimColor>
              {line}
            </Text>
          ))
        )}
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
    </FormFrame>
  );
}
