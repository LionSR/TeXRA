import { Effect } from 'effect';

import { AgentCatalog, type AgentEntry } from '@texra-ai/harness/host';
import { agentKeyOf } from '@texra-ai/harness/schemas';

import {
  cliCommandDefaults,
  setWorkspaceCliChatAgent,
} from '@cli/runtime/platform/cliConfig';
import { SettingsRequestFailed } from '@texra/controllers/settingsView/settingsHostBindings';
import { TICK } from '@cli/tui/ui/glyphs';
import { BACK_HINT } from '@cli/tui/ui/KeyHints';
import { ToneLine } from '@cli/tui/ui/ToneLine';

import { renderAsyncListFormTransient } from './_shared/FormFrame';
import { ListForm } from './_shared/ListForm';
import { runFormWrite, useAsyncListForm } from './_shared/useAsyncListForm';
import { useChatProcess } from '../chatProcess';

interface DefaultChatAgentFormProps {
  /** The project the process opened, whose default this form writes. */
  readonly workspaceRoot: string | undefined;
  readonly availableRows?: number;
  readonly onClose: () => void;
  readonly onError?: (error: unknown) => void;
}

/** The agent new chats in the project start on: one of the catalog's, or
 *  the automatic default. */
export function DefaultChatAgentForm(
  props: DefaultChatAgentFormProps,
): React.JSX.Element | null {
  const { roots, chat } = useChatProcess();
  const { data, error, reload, reportError } = useAsyncListForm<
    readonly AgentEntry[]
  >({
    load: () => Effect.map(AgentCatalog, (catalog) => [...catalog.list()]),
    onClose: props.onClose,
    onError: props.onError,
  });

  if (!data) {
    return renderAsyncListFormTransient({
      loading: error === undefined,
      error,
      title: '/config · Default chat agent',
      loadingLabel: 'Loading agents…',
    });
  }

  const current = cliCommandDefaults(roots, 'chat').agent ?? '';
  const mark = (value: string) => (value === current ? `${TICK} ` : '');
  const notices = error
    ? [<ToneLine key="error" tone="danger" text={error} />]
    : [];
  return (
    <ListForm
      title="/config · Default chat agent"
      availableRows={props.availableRows}
      items={[
        {
          value: '',
          label: `${mark('')}Automatic`,
          description: 'Choose from the agents',
        },
        ...data.map((agent) => ({
          value: agentKeyOf(agent),
          label: `${mark(agentKeyOf(agent))}${agent.name}`,
          description: agent.description,
        })),
      ]}
      detail={notices}
      detailRows={notices.length}
      action="select"
      escape={BACK_HINT}
      onSelect={(value) =>
        runFormWrite(
          chat,
          () =>
            props.workspaceRoot
              ? setWorkspaceCliChatAgent(roots, value || undefined)
              : Effect.fail(
                  new SettingsRequestFailed({
                    message:
                      'Default chat-agent selection requires a workspace.',
                  }),
                ),
          { onSuccess: reload, onError: reportError },
        )
      }
      onCancel={props.onClose}
    />
  );
}
