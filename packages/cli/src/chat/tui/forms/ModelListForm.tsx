// `/model` form. It shows the same registry used by `texra models list`.
// Before the first message it can choose the root model; after that it is
// read-only because an active conversation owns a concrete model handler.

import { Box, Text, useInput } from 'ink';
import { Spinner } from '@inkjs/ui';
import { useEffect, useState } from 'react';

import { Select } from '../ui/Select';
import { KeyHints } from '../ui/KeyHints';
import {
  getCliModelAccessList,
  type CliModelAccess,
} from '../../../runtime/modelAccess';
import {
  formatCliApiMode,
  type CliApiMode,
} from '../../../runtime/apiAccessMode';

export interface ModelListFormProps {
  readonly currentModel: string;
  readonly apiMode: CliApiMode;
  readonly selectable?: boolean;
  readonly onSelect?: (value: string) => void;
  readonly onClose: () => void;
}

interface ModelFrameProps {
  readonly color: string;
  readonly title: string;
  readonly children: React.ReactNode;
}

function ModelFrame(props: ModelFrameProps): React.JSX.Element {
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

export function formatModelStatusForCliMode(
  model: CliModelAccess,
  apiMode: CliApiMode,
): string {
  if (apiMode === 'personal') return `api: ${model.status}`;

  switch (model.model.availability) {
    case 'included-access':
      return 'relay: included';
    case 'not-included':
      return 'relay: not included';
    case 'provider-key':
      return 'relay: unavailable; api key set';
    case 'openrouter-key':
      return 'relay: unavailable; openrouter key set';
    case 'missing-key':
      return 'relay: unavailable; missing api key';
    default:
      return `relay: ${model.status}`;
  }
}

export function ModelListForm(props: ModelListFormProps): React.JSX.Element {
  const [models, setModels] = useState<readonly CliModelAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((_input, key) => {
    if ((loading || error) && key.escape) {
      props.onClose();
    }
  });

  useEffect(() => {
    let cancelled = false;
    void getCliModelAccessList()
      .then((list) => {
        if (cancelled) return;
        setModels(list);
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
      <ModelFrame color="cyan" title="/model">
        <Spinner label="Loading model registry..." />
      </ModelFrame>
    );
  }
  if (error) {
    return (
      <ModelFrame color="red" title="/model - error">
        <Text>{error}</Text>
      </ModelFrame>
    );
  }

  const items = models.map((m) => ({
    value: m.model.value,
    label: m.model.label || m.model.value,
    description: formatModelStatusForCliMode(m, props.apiMode),
    disabled: props.selectable ? !m.available : false,
  }));
  const selectable = props.selectable === true;

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        {`/model · ${formatCliApiMode(props.apiMode)}`}
      </Text>
      <Text dimColor>
        {selectable
          ? 'Choose the root model for the first message.'
          : 'Available models. Start a new chat with texra --model=<name> to choose the root model.'}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Select
          items={items}
          activeValue={props.currentModel}
          onSelect={(value) => {
            if (selectable) {
              props.onSelect?.(value);
              return;
            }
            props.onClose();
          }}
          onCancel={props.onClose}
        />
      </Box>
      <Box marginTop={1}>
        {selectable ? (
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: '1-9', action: 'select' },
            ]}
          />
        ) : (
          <KeyHints
            hints={[
              { key: '↑/↓', action: 'navigate' },
              { key: 'Enter', action: 'close' },
              { key: 'Esc', action: 'close' },
            ]}
            confirmCancel={false}
          />
        )}
      </Box>
    </Box>
  );
}
