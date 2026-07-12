// `/tools` form. It mirrors `texra tools list` inside an active TUI session
// and toggles integrations that are marked toggleable in EXTERNAL_TOOL_DEFS.

import { Box, Text } from 'ink';

import {
  readCliToolStatuses,
  setCliToolEnabled,
  type CliToolStatusRecord,
} from '@cli/runtime/tools';
import { toolStatusLabel } from '@shared/tools/toolStatusLabels';
import { KeyHints } from '../ui/KeyHints';
import { Select } from '../ui/Select';
import {
  CompactFormKeyHints,
  FormFrame,
  renderAsyncListFormTransient,
} from './_shared/FormFrame';
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
  return toolStatusLabel(tool.status, tool.statusLabel);
}

export function formatToolDescriptionForTui(tool: CliToolStatusRecord): string {
  return [
    formatToolEnablementForTui(tool),
    formatToolDetectionForTui(tool.detected),
    formatToolStatusForTui(tool),
  ].join(' · ');
}

export function toolsSelectWindow(args: {
  readonly availableRows: number | undefined;
  readonly itemCount: number;
}): SelectWindowSize {
  return computeSelectWindowSize({ ...args, chromeRows: 6 });
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

  const transient = renderAsyncListFormTransient({
    loading,
    error,
    title: '/tools',
    loadingLabel: 'Checking tool integrations...',
    showCloseHint: false,
  });
  if (transient) return transient;

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

  function handleToggle(id: string): void {
    const tool = tools.find((candidate) => candidate.id === id);
    if (!tool || tool.enabled == null) return;
    void setCliToolEnabled(id, !tool.enabled)
      .then(() => readCliToolStatuses())
      .then(setTools);
  }

  if (isCompactFormRows(props.availableRows)) {
    return (
      <FormFrame
        title="/tools · Toggle available external integrations."
        showCloseHint={false}
      >
        <Select
          items={items}
          maxVisibleItems={1}
          showOverflow={false}
          onSelect={handleToggle}
          onCancel={props.onClose}
        />
        <CompactFormKeyHints
          primary={{ key: '1-9/a-z/Enter', action: 'toggle' }}
        />
      </FormFrame>
    );
  }

  return (
    <FormFrame title="/tools" showCloseHint={false}>
      <Text dimColor>Toggle available external integrations.</Text>
      <Select
        items={items}
        maxVisibleItems={selectWindow.maxVisibleItems}
        showOverflow={selectWindow.showOverflow}
        onSelect={handleToggle}
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
