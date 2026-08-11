import { Box, Text } from 'ink';
import { useState } from 'react';

import {
  loadCliModelAccessOverview,
  type CliModelAccessOverview,
} from '@cli/runtime/apiStatus';
import {
  buildCliModelAccessItems,
  cliApiFallbackSelection,
  CLI_MODEL_ACCESS_DESCRIPTION,
  type CliModelAccessSelection,
} from '@cli/runtime/modelAccessRoute';

import { useCancellableEffect } from '@cli/tui/useCancellableEffect';
import { LoadingIndicator } from '@cli/tui/ui/LoadingIndicator';
import type { ApiAccessMode } from '@shared/schemas/settingsViewMessages';
import { ListForm } from './_shared/ListForm';

interface ModelAccessFormProps {
  readonly apiMode: ApiAccessMode;
  readonly availableRows?: number;
  readonly onSelect: (value: CliModelAccessSelection) => void;
  readonly onCancel: () => void;
}

type ModelAccessFormStatus =
  | { readonly state: 'loaded'; readonly overview: CliModelAccessOverview }
  | { readonly state: 'failed'; readonly message: string };

export function ModelAccessForm(
  props: ModelAccessFormProps,
): React.JSX.Element {
  const [status, setStatus] = useState<ModelAccessFormStatus | null>(null);

  useCancellableEffect(
    (isCancelled) => {
      setStatus(null);
      void loadCliModelAccessOverview({ apiMode: props.apiMode })
        .then((overview) => {
          if (!isCancelled()) setStatus({ state: 'loaded', overview });
        })
        .catch((error: unknown) => {
          if (!isCancelled()) {
            setStatus({
              state: 'failed',
              message: String(error),
            });
          }
        });
    },
    [props.apiMode],
  );

  const items =
    status?.state === 'loaded'
      ? buildCliModelAccessItems({
          kind: 'loaded',
          access: status.overview.access,
        })
      : buildCliModelAccessItems({
          kind: 'pending',
          state: status?.state ?? 'loading',
        });
  const detailLines =
    status?.state === 'loaded'
      ? status.overview.lines
      : status?.state === 'failed'
        ? [status.message]
        : undefined;

  return (
    <ListForm
      title="/api · Model access"
      availableRows={props.availableRows}
      items={items}
      compactVisibleItems={items.length}
      activeValue={cliApiFallbackSelection(props.apiMode)}
      description={<Text dimColor>{CLI_MODEL_ACCESS_DESCRIPTION}</Text>}
      detail={
        <Box marginTop={1} flexDirection="column">
          {detailLines === undefined ? (
            <LoadingIndicator label="loading model access..." />
          ) : (
            detailLines.map((line, index) => (
              <Text key={`${index}:${line}`} dimColor>
                {line}
              </Text>
            ))
          )}
        </Box>
      }
      detailRows={1 + (detailLines?.length ?? 1)}
      selectMarginTop={1}
      action="select"
      onSelect={props.onSelect}
      onCancel={props.onCancel}
    />
  );
}
