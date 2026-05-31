// `/tools` form. It mirrors `texra tools list` inside an active TUI session
// and toggles integrations that are marked toggleable in EXTERNAL_TOOL_DEFS.

import { Box, Text } from 'ink';
import { Spinner } from '@inkjs/ui';

import {
  readCliToolStatuses,
  setCliToolEnabled,
  type CliToolStatusRecord,
} from '@cli/runtime/tools';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import { FormFrame } from './_shared/FormFrame';
import {
  computeSelectWindowSize,
  isCompactFormRows,
  type SelectWindowSize,
} from './_shared/selectWindow';
import { useAsyncListForm } from './_shared/useAsyncListForm';

export interface ToolsListFormProps {
  readonly availableRows?: number;
  readonly onClose: () => void;
}

function formatToolEnablementForTui(tool: CliToolStatusRecord): string {
  if (tool.comingSoon) return 'coming soon';
  if (!tool.toggleable) return 'always on';
  return tool.enabled === false ? 'disabled' : 'enabled';
}

function formatToolDetectionForTui(
  detected: CliToolStatusRecord['detected'],
): string {
  if (detected === true) return 'detected';
  if (detected === false) return 'not detected';
  return 'detection unknown';
}

function formatToolStatusForTui(tool: CliToolStatusRecord): string {
  if (tool.comingSoon) return 'not yet usable';
  return tool.statusLabel ?? tool.status;
}

export function formatToolDescriptionForTui(tool: CliToolStatusRecord): string {
  return [
    formatToolEnablementForTui(tool),
    formatToolDetectionForTui(tool.detected),
    formatToolStatusForTui(tool),
  ].join(' · ');
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
    description: formatToolDescriptionForTui(tool),
    disabled: !tool.toggleable || tool.comingSoon,
  }));

  if (isCompactFormRows(props.availableRows)) {
    return (
      <FormFrame color="cyan" title="/tools · Esc close" showCloseHint={false}>
        <Text dimColor wrap="truncate-end">
          Toggle available external integrations.
        </Text>
        <Select
          items={items}
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
      </FormFrame>
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
