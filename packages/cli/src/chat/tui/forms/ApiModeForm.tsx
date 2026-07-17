import { Box, Text } from 'ink';
import { useState } from 'react';

import { type CliApiMode } from '@cli/runtime/apiAccessMode';
import { loadCliApiStatusLines } from '@cli/runtime/apiStatus';
import { useCancellableEffect } from '../state/useCancellableEffect';
import { LoadingIndicator } from '../ui/LoadingIndicator';
import { ListForm } from './_shared/ListForm';

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

  return (
    <ListForm
      title="/api"
      availableRows={props.availableRows}
      items={items}
      compactVisibleItems={items.length}
      activeValue={props.currentMode}
      description={
        <Text dimColor>Choose how model calls are authenticated.</Text>
      }
      detail={
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
      }
      detailRows={1 + (statusLines?.length ?? 1)}
      selectMarginTop={1}
      action="select"
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
}
