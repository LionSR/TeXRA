// `/tools` form. It mirrors `texra tools list` inside an active TUI session
// and toggles integrations that are marked toggleable in EXTERNAL_TOOL_DEFS.

import { Text } from 'ink';

import {
  readCliToolStatuses,
  setCliToolEnabled,
  type CliToolStatusRecord,
} from '@cli/runtime/tools';
import { toolStatusLabel } from '@shared/tools/toolStatusLabels';
import { AsyncListForm } from './_shared/ListForm';

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

export function ToolsListForm(props: ToolsListFormProps): React.JSX.Element {
  return (
    <AsyncListForm<readonly CliToolStatusRecord[], string>
      title="/tools"
      compactTitle="/tools · Toggle available external integrations."
      loadingLabel="Checking tool integrations..."
      load={readCliToolStatuses}
      items={(tools) =>
        tools.map((tool) => ({
          value: tool.id,
          label: tool.name,
          description: formatToolDescriptionForTui(tool),
          disabled: !tool.toggleable || tool.comingSoon,
        }))
      }
      availableRows={props.availableRows}
      description={
        <Text dimColor>Toggle available external integrations.</Text>
      }
      action="toggle"
      showTransientCloseHint={false}
      onSelect={(id, { data: tools, setData: setTools }) => {
        const tool = tools.find((candidate) => candidate.id === id);
        if (!tool || tool.enabled == null) return;
        void setCliToolEnabled(id, !tool.enabled)
          .then(() => readCliToolStatuses())
          .then(setTools);
      }}
      onCancel={props.onClose}
    />
  );
}
