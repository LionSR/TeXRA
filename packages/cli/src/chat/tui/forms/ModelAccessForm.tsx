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

  const items = buildCliModelAccessItems(
    status?.state === 'loaded'
      ? status.overview.access
      : {
          apiMode: props.apiMode,
          chatGpt: {
            signedIn: false,
            email: null,
            accountId: null,
            preferSubscription: false,
            subscriptionToolUseOnly: false,
          },
          kimiCode: {
            keySet: false,
            preferred: false,
          },
          personalApiKeySet: false,
          texraSignedIn: false,
        },
  );
  let detailLines: readonly string[] | undefined;
  if (status?.state === 'loaded') detailLines = status.overview.lines;
  if (status?.state === 'failed') detailLines = [status.message];

  return (
    <ListForm
      title="/api · Model access"
      availableRows={props.availableRows}
      items={items}
      compactVisibleItems={items.length}
      activeValue={
        status?.state === 'loaded' ? status.overview.access.apiMode : undefined
      }
      description={
        <Text dimColor>
          Subscription preferences are independent; fallback access applies to
          other models.
        </Text>
      }
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
