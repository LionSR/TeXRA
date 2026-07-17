import { Box, Text } from 'ink';
import { useState } from 'react';

import { type CliApiMode } from '@cli/runtime/apiAccessMode';
import {
  loadCliModelAccessOverview,
  type CliModelAccessOverview,
} from '@cli/runtime/apiStatus';
import {
  buildCliModelAccessItems,
  type CliModelAccessRoute,
} from '@cli/runtime/modelAccessRoute';

import { useCancellableEffect } from '../state/useCancellableEffect';
import { LoadingIndicator } from '../ui/LoadingIndicator';
import { ListForm } from './_shared/ListForm';

interface ModelAccessFormProps {
  readonly apiMode: CliApiMode;
  readonly availableRows?: number;
  readonly onSelect: (value: CliModelAccessRoute) => void;
  readonly onCancel: () => void;
}

export function ModelAccessForm(
  props: ModelAccessFormProps,
): React.JSX.Element {
  const [status, setStatus] = useState<CliModelAccessOverview | null>(null);

  useCancellableEffect(
    (isCancelled) => {
      setStatus(null);
      void loadCliModelAccessOverview({ apiMode: props.apiMode })
        .then((overview) => {
          if (!isCancelled()) setStatus(overview);
        })
        .catch((error: unknown) => {
          if (!isCancelled()) {
            setStatus({
              access: {
                active: props.apiMode,
                chatGptSignedIn: false,
              },
              lines: [String(error)],
            });
          }
        });
    },
    [props.apiMode],
  );

  const items = buildCliModelAccessItems(
    status?.access ?? {
      active: props.apiMode,
      chatGptSignedIn: false,
    },
  );

  return (
    <ListForm
      title="/api · Model access"
      availableRows={props.availableRows}
      items={items}
      compactVisibleItems={items.length}
      activeValue={status?.access.active ?? props.apiMode}
      description={
        <Text dimColor>Choose how model calls are authenticated.</Text>
      }
      detail={
        <Box marginTop={1} flexDirection="column">
          {status === null ? (
            <LoadingIndicator label="loading model access..." />
          ) : (
            status.lines.map((line, index) => (
              <Text key={`${index}:${line}`} dimColor>
                {line}
              </Text>
            ))
          )}
        </Box>
      }
      detailRows={1 + (status?.lines.length ?? 1)}
      selectMarginTop={1}
      action="select"
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
}
