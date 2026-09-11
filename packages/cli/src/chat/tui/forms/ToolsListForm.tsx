// `/tools` form. It mirrors `texra tools list` inside an active TUI session
// and toggles integrations that are marked toggleable in EXTERNAL_TOOL_DEFS.

import { Text } from 'ink';

import {
  readCliToolStatuses,
  setCliToolEnabled,
  type CliToolStatusRecord,
} from '@cli/runtime/tools';
import { toolDependencyStatusLabel } from '@shared/tools/toolDependencyStatusLabels';
import { toErrorMessage } from '@utils/errors/errorMessage';

import { setTransientNotice } from '../state/cliState';
import { AsyncListForm } from './_shared/ListForm';

interface ToolsListFormProps {
  readonly availableRows?: number;
  readonly onClose: () => void;
}

function formatToolEnablementForTui(tool: CliToolStatusRecord): string {
  if (!tool.toggleable) return 'always on';
  return tool.enabled === false ? 'disabled' : 'enabled';
}

// Undefined when detection has not run: the status part already says the tool
// has not been checked, and a bare "unknown" segment names nothing.
function formatToolDetectionForTui(
  detected: CliToolStatusRecord['detected'],
): string | undefined {
  if (detected === true) return 'detected';
  if (detected === false) return 'not detected';
  return undefined;
}

function formatToolDescriptionForTui(tool: CliToolStatusRecord): string {
  return [
    formatToolEnablementForTui(tool),
    formatToolDetectionForTui(tool.detected),
    toolDependencyStatusLabel(tool.status, tool.statusLabel),
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
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
          disabled: !tool.toggleable,
        }))
      }
      availableRows={props.availableRows}
      description={
        <Text dimColor>Toggle available external integrations.</Text>
      }
      action="toggle"
      showTransientCloseHint={false}
      onSelect={(id, { data: tools, reload }) => {
        const tool = tools.find((candidate) => candidate.id === id);
        if (!tool || tool.enabled == null) return;
        void setCliToolEnabled(id, !tool.enabled)
          .then(reload)
          .catch((error: unknown) => {
            setTransientNotice(toErrorMessage(error));
          });
      }}
      onCancel={props.onClose}
    />
  );
}
