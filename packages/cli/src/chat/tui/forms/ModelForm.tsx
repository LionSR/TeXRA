// Single-screen `/model` form. Renders the resolved model list with
// availability status, lets the user pick a new active model with arrow
// keys + Enter, and writes the choice back into `cliState.sessionMeta`
// alongside the existing CLI helper-model wiring.
//
// Phase 5b ships the *picker* surface; ramping the new selection through
// `setCliHelperModel` for follow-up turns is a downstream concern handled
// by the caller's `onPick` (see `App.tsx` → `applyModelSelection`).

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
      <Box
        borderStyle="round"
        borderColor="cyan"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="cyan">
          /model
        </Text>
        <Text dimColor>Loading model registry…</Text>
        <Box marginTop={1}>
          <KeyHints
            hints={[{ key: 'Esc', action: 'cancel' }]}
            confirmCancel={false}
          />
        </Box>
      </Box>
    );
  }
  if (error) {
    return (
      <Box
        borderStyle="round"
        borderColor="red"
        flexDirection="column"
        paddingX={1}
      >
        <Text bold color="red">
          /model — error
        </Text>
        <Text>{error}</Text>
        <Box marginTop={1}>
          <KeyHints
            hints={[{ key: 'Esc', action: 'cancel' }]}
            confirmCancel={false}
          />
        </Box>
      </Box>
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
