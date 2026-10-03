// `/config` → Tools form. It mirrors `texra tools list` inside an active TUI session
// and toggles integrations whose plugin is marked toggleable.

import { Text } from 'ink';

import {
  cliToolDetected,
  cliToolEnabled,
  readCliToolStatuses,
  setCliToolEnabled,
} from '@cli/runtime/tools';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { SettingsStores } from '@shared/config/settingsAccess';
import type { ToolDashboardItem } from '@shared/settingsView/settingsViewMessages';
import { toolDependencyStatusLabel } from '@shared/tools/toolDependencyStatusLabels';

import { AsyncListForm } from './_shared/ListForm';

interface ToolsListFormProps {
  readonly availableRows?: number;
  /**
   * The session's stores: the global state the toggle writes, and the host
   * and configuration the probes read. Ink components run no Effect, so they
   * arrive as a prop from the surface that opened the form.
   */
  readonly stores: SettingsStores;
  /**
   * The process runtime the tool probes run on, and whose `AppState` is that
   * same store, from the same surface.
   */
  readonly runtime: ProcessRuntime;
  /** The session's workspace folder, for the probes that need one. */
  readonly workspaceRoot: string | undefined;
  readonly onClose: () => void;
}

function formatToolEnablementForTui(tool: ToolDashboardItem): string {
  const enabled = cliToolEnabled(tool);
  if (enabled === null) return 'always on';
  return enabled === false ? 'disabled' : 'enabled';
}

// Undefined when detection has not run: the status part already says the tool
// has not been checked, and a bare "unknown" segment names nothing.
function formatToolDetectionForTui(
  detected: boolean | null,
): string | undefined {
  if (detected === true) return 'detected';
  if (detected === false) return 'not detected';
  return undefined;
}

function formatToolDescriptionForTui(tool: ToolDashboardItem): string {
  return [
    formatToolEnablementForTui(tool),
    formatToolDetectionForTui(cliToolDetected(tool)),
    toolDependencyStatusLabel(tool.status, tool.statusLabel),
  ]
    .filter((part): part is string => part !== undefined)
    .join(' · ');
}

export function ToolsListForm(props: ToolsListFormProps): React.JSX.Element {
  return (
    <AsyncListForm<readonly ToolDashboardItem[], string>
      title="/config · Tools"
      compactTitle="/config · Tools · Toggle external integrations."
      loadingLabel="Checking tool integrations..."
      load={() =>
        readCliToolStatuses({
          workspace: props.workspaceRoot,
          config: props.stores.config,
          host: props.stores.host,
        })
      }
      runtime={props.runtime}
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
      onSelect={(id, { data: tools, update }) => {
        const tool = tools.find((candidate) => candidate.id === id);
        const enabled = tool ? cliToolEnabled(tool) : null;
        if (enabled !== null) {
          update(setCliToolEnabled(props.stores.globalState, id, !enabled));
        }
      }}
      onCancel={props.onClose}
    />
  );
}
