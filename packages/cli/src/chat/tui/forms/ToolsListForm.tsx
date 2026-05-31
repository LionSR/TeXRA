// `/tools` form. It mirrors `texra tools list` inside an active TUI session
// and toggles integrations that are marked toggleable in EXTERNAL_TOOL_DEFS.

import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';

import {
  formatCliBoolean,
  readCliToolStatuses,
  setCliToolEnabled,
  type CliToolStatusRecord,
} from '@cli/runtime/tools';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import {
  CompactFormFrame,
  shouldUseCompactForm,
} from './_shared/CompactFormFrame';
import { FormFrame } from './_shared/FormFrame';
import {
  computeSelectWindowSize,
  type SelectWindowSize,
} from './_shared/selectWindow';
import { useAsyncListForm } from './_shared/useAsyncListForm';

export interface ToolsListFormProps {
  readonly availableRows?: number;
  readonly onClose: () => void;
}

function toolDescription(tool: CliToolStatusRecord): string {
  const enabled = `enabled ${formatCliBoolean(tool.enabled)}`;
  const detected = `detected ${formatCliBoolean(tool.detected)}`;
  const status = tool.statusLabel ?? tool.status;
  return `${enabled}; ${detected}; ${status}`;
}

function toolsSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
}): SelectWindowSize {
  return computeSelectWindowSize({ ...args, chromeRows: 5 });
}

export function ToolsListForm(props: ToolsListFormProps): React.JSX.Element {
  const {
    data,
    loading,
    error,
    setData: setTools,
  } = useAsyncListForm<readonly CliToolStatusRecord[]>({
    load: readCliToolStatuses,
    onClose: props.onClose,
  });

  if (loading) {
    return (
      <FormFrame color="cyan" title="/tools" showCloseHint={false}>
        <Spinner label="Checking tool integrations..." />
      </FormFrame>
    );
  }

  if (error) {
    return (
      <FormFrame color="red" title="/tools - error" showCloseHint={false}>
        <Text>{error}</Text>
      </FormFrame>
    );
  }

  const tools = data ?? [];
  const selectWindow = toolsSelectWindow({
    availableRows: props.availableRows,
    itemCount: tools.length,
  });
  const items = tools.map((tool) => ({
    value: tool.id,
    label: tool.name,
    description: toolDescription(tool),
    disabled: !tool.toggleable || tool.comingSoon,
  }));

  if (shouldUseCompactForm(props.availableRows)) {
    const compactItems = items.map((item) => ({
      value: item.value,
      label: item.label,
      description: item.description,
      disabled: item.disabled,
    }));
    return (
      <CompactFormFrame
        title="/tools"
        description="Toggle available external integrations."
        hints={[
          { key: '↑/↓', action: 'navigate' },
          { key: 'Enter', action: 'toggle' },
          { key: 'Esc', action: 'close' },
        ]}
        confirmCancel={false}
      >
        <Select
          items={compactItems}
          maxVisibleItems={1}
          showOverflow={false}
          onSelect={(id) => {
            const tool = tools.find((candidate) => candidate.id === id);
            if (!tool || tool.enabled == null) return;
            void setCliToolEnabled(id, !tool.enabled)
              .then(() => readCliToolStatuses())
              .then(setTools);
          }}
          onCancel={props.onClose}
        />
      </CompactFormFrame>
    );
  }

  return (
    <FormFrame color="cyan" title="/tools" showCloseHint={false}>
      <Text dimColor>Toggle available external integrations.</Text>
      <Select
        items={items}
        maxVisibleItems={selectWindow.maxVisibleItems}
        showOverflow={selectWindow.showOverflow}
        onSelect={(id) => {
          const tool = tools.find((candidate) => candidate.id === id);
          if (!tool || tool.enabled == null) return;
          void setCliToolEnabled(id, !tool.enabled)
            .then(() => readCliToolStatuses())
            .then(setTools);
        }}
        onCancel={props.onClose}
      />
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: '↑/↓', action: 'navigate' },
            { key: 'Enter', action: 'toggle' },
            { key: 'Esc', action: 'close' },
          ]}
          confirmCancel={false}
        />
      </Box>
    </FormFrame>
  );
}
