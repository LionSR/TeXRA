// Single-screen `/model` form. Renders the resolved model list with
// availability status, lets the user pick a new active model with arrow
// keys + Enter, and forwards the choice to `onSelect`. Ramping the new
// selection through `setCliHelperModel` is a downstream concern handled
// by the caller (see `commands/registerBuiltins.tsx`).

import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';

import { Select } from '../ui/Select';
import { KeyHints } from '../ui/KeyHints';
import {
  getCliModelAccessList,
  type CliModelAccess,
} from '../../../runtime/modelAccess';

export interface ModelFormProps {
  readonly currentModel: string;
  readonly onSelect: (value: string) => void;
  readonly onCancel: () => void;
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
          hints={[{ key: 'Esc', action: 'cancel' }]}
          confirmCancel={false}
        />
      </Box>
    </Box>
  );
}

export function ModelForm(props: ModelFormProps): React.JSX.Element {
  const [models, setModels] = useState<readonly CliModelAccess[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  useInput((_input, key) => {
    if ((loading || error) && key.escape) {
      props.onCancel();
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
        <Text dimColor>Loading model registry…</Text>
      </ModelFrame>
    );
  }
  if (error) {
    return (
      <ModelFrame color="red" title="/model — error">
        <Text>{error}</Text>
      </ModelFrame>
    );
  }

  const items = models.map((m) => ({
    value: m.model.value,
    label: m.model.label || m.model.value,
    description: m.status,
    disabled: !m.available,
  }));

  return (
    <Box
      borderStyle="round"
      borderColor="cyan"
      flexDirection="column"
      paddingX={1}
    >
      <Text bold color="cyan">
        /model
      </Text>
      <Text dimColor>Pick a model. ✓ marks the current selection.</Text>
      <Box marginTop={1} flexDirection="column">
        <Select
          items={items}
          activeValue={props.currentModel}
          onSelect={props.onSelect}
          onCancel={props.onCancel}
        />
      </Box>
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: '1-9', action: 'jump' },
          ]}
        />
      </Box>
    </Box>
  );
}
