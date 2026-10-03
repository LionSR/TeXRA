// `/plugins`: the one row list the settings view's Plugins page renders
// (`@controllers/settingsView/pluginRows`). Enter switches a TeXRA plugin or
// an installed plugin on or off; switching an untrusted plugin on shows what
// it declares and asks first. MCP servers are listed read-only.

import { Box, Text } from 'ink';
import { useState } from 'react';
import { Effect } from 'effect';

import { setCliToolEnabled } from '@cli/runtime/tools';
import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { disablePlugin, enablePlugin } from '@common/plugins/pluginTrust';
import type { PluginReview } from '@common/plugins/pluginTrust';
import { buildPluginRows } from '@controllers/settingsView/pluginRows';
import type { ProcessRuntime } from '@platform/processRuntime';
import type { WorkspaceRoots } from '@platform/workspaceRoots';
import type { PluginRow } from '@shared/settingsView/settingsViewMessages';
import {
  PLUGINS_PAGE,
  PLUGINS_TUI,
  pluginRowName,
  pluginRowProblem,
  pluginRowState,
  pluginRowSummary,
  pluginRowTrust,
  pluginRowUsedBy,
} from '@ui/copy/plugins';

import { AsyncListForm } from './_shared/ListForm';

interface PluginsListFormProps {
  readonly availableRows?: number;
  /** The session's roots: the install record and switches live in its
   *  global state, the managed plugins under its global storage, and the
   *  availability probes read its folder and configuration. */
  readonly roots: Pick<
    WorkspaceRoots,
    'host' | 'workspace' | 'config' | 'globalState' | 'globalStorage'
  >;
  /** The process runtime the probes and writes run on. */
  readonly runtime: ProcessRuntime;
  readonly onClose: () => void;
}

/** A trust question waiting on the user: what the plugin declares, and the
 *  continuation `enablePlugin` is suspended on. */
interface PendingTrust {
  readonly review: PluginReview;
  readonly answer: (trusted: boolean) => void;
}

const TRUST = 'trust';
const DECLINE = 'decline';

/** The row's select value: unique across the three kinds. */
const rowValue = (row: PluginRow): string => {
  switch (row.kind) {
    case 'texra':
      return `texra:${row.item.id}`;
    case 'installed':
      return `installed:${row.plugin.name}`;
    case 'mcp':
      return `mcp:${row.name}`;
  }
};

/** Whether Enter can switch the row: one with no switch is listed only. */
const switchable = (row: PluginRow): boolean => {
  switch (row.kind) {
    case 'texra':
      return row.item.toggleable === true;
    case 'installed':
      return row.plugin.code.length === 0 && row.plugin.problem === undefined;
    case 'mcp':
      return false;
  }
};

function rowDescription(row: PluginRow): string {
  return [
    pluginRowState(row),
    pluginRowSummary(row),
    pluginRowTrust(row),
    pluginRowProblem(row),
    pluginRowUsedBy(row),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ');
}

export function PluginsListForm(
  props: PluginsListFormProps,
): React.JSX.Element {
  const [pending, setPending] = useState<PendingTrust | null>(null);
  const { roots } = props;

  // Suspends the enable until the user answers in this form.
  const confirmTrust = (review: PluginReview) =>
    Effect.callback<boolean>((resume) => {
      setPending({
        review,
        answer: (trusted) => {
          setPending(null);
          resume(Effect.succeed(trusted));
        },
      });
    });

  const toggle = (row: PluginRow) => {
    if (row.kind === 'texra')
      return setCliToolEnabled(
        roots.globalState,
        row.item.id,
        row.item.enabled === false,
      ).pipe(Effect.asVoid);
    if (row.kind === 'installed')
      // On and trusted switches off; on but changed since it was trusted
      // opens the review, as switching on does.
      return row.plugin.enabled && row.plugin.trusted
        ? disablePlugin(row.plugin.name, roots)
        : enablePlugin(row.plugin.name, roots, confirmTrust).pipe(
            Effect.asVoid,
          );
    return Effect.void;
  };

  return (
    <AsyncListForm<Effect.Success<ReturnType<typeof buildPluginRows>>, string>
      title={pending ? PLUGINS_TUI.trustTitle(pending.review.name) : '/plugins'}
      compactTitle={
        pending
          ? PLUGINS_TUI.trustTitle(pending.review.name)
          : PLUGINS_TUI.compactTitle
      }
      loadingLabel={PLUGINS_PAGE.loading}
      load={() => buildPluginRows(roots)}
      runtime={props.runtime}
      isEmpty={(data) => data.rows.length === 0}
      items={(data) =>
        pending
          ? [
              { value: TRUST, label: PLUGINS_TUI.trust },
              { value: DECLINE, label: PLUGINS_TUI.decline },
            ]
          : data.rows.map((row) => ({
              value: rowValue(row),
              label: pluginRowName(row),
              description: rowDescription(row),
              disabled: !switchable(row),
            }))
      }
      emptyMessage={PLUGINS_PAGE.empty}
      availableRows={props.availableRows}
      description={
        pending ? undefined : <Text dimColor>{PLUGINS_TUI.description}</Text>
      }
      detailFor={(data) => {
        if (pending)
          return (
            <Box flexDirection="column">
              {pending.review.lines.map((line, index) => (
                <Text key={index}>{line}</Text>
              ))}
            </Box>
          );
        if (data.mcpWarnings.length === 0) return undefined;
        return <Text color={COLOR_WARNING}>{data.mcpWarnings.join(' ')}</Text>;
      }}
      // A trust question shows what it declares in every layout: the compact
      // one keeps the lines, not the list's warnings.
      compactDetailFor={() =>
        pending ? (
          <Box flexDirection="column">
            {pending.review.lines.map((line, index) => (
              <Text key={index}>{line}</Text>
            ))}
          </Box>
        ) : undefined
      }
      detailRowsFor={(data) => {
        if (pending) return pending.review.lines.length;
        return data.mcpWarnings.length > 0 ? 1 : 0;
      }}
      action={pending ? PLUGINS_TUI.chooseAction : PLUGINS_TUI.switchAction}
      showTransientCloseHint={false}
      onSelect={(value, { data, update }) => {
        if (pending) {
          pending.answer(value === TRUST);
          return;
        }
        const row = data.rows.find(
          (candidate) => rowValue(candidate) === value,
        );
        if (row && switchable(row)) update(toggle(row));
      }}
      onCancel={() => (pending ? pending.answer(false) : props.onClose())}
    />
  );
}
