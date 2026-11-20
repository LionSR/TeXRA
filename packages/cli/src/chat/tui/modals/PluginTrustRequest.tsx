import { Text, useWindowSize } from 'ink';

import { COLOR_WARNING } from '@cli/tui/ui/colors';
import { confirmCardContentWidth } from '@cli/tui/ui/theme';
import { truncateToWidth } from '@cli/runtime/terminal/terminalText';

import type { SurfaceDecision } from '@texra/shared/session/surfaceDecision';
import { pluginTrustFacts, REQUEST_ASK } from '@ui/copy/requestCards';
import { ConfirmCard } from './ConfirmCard';
import {
  ScrollableModalText,
  scrollableModalTextRowsBudget,
} from './ScrollableModalText';
import type {
  ApprovalBypassKind,
  PluginTrustRequest as PluginTrustPayload,
} from '@texra-ai/harness/schemas';

interface PluginTrustRequestProps {
  readonly availableRows?: number;
  readonly payload: PluginTrustPayload;
  /** The run grant the request offers (`offeredGrant`): none when only a
   *  person answers it, as for native code. */
  readonly grant: ApprovalBypassKind | null;
  readonly onDecide: (decision: SurfaceDecision) => void;
}

/** Trusting an installed plugin: its name and version in the title, a
 *  warning line when it carries native code, where it is, then the whole
 *  review, scrollable. */
export function PluginTrustRequest(
  props: PluginTrustRequestProps,
): React.JSX.Element {
  const { columns } = useWindowSize();
  const { payload } = props;
  const width = confirmCardContentWidth(columns);
  const facts = pluginTrustFacts(payload);
  const title = `${REQUEST_ASK.pluginTrust} ${facts.plugin}`;
  const lines = [
    ...(payload.native ? [REQUEST_ASK.nativeCode] : []),
    facts.location,
  ].map((line) => truncateToWidth(line, width));
  const maxRows = scrollableModalTextRowsBudget({
    availableRows: props.availableRows,
    columns,
    extraFixedRows: lines.length,
    title,
  });
  return (
    <ConfirmCard
      color={COLOR_WARNING}
      title={title}
      kind="pluginTrust"
      grant={props.grant}
      onDecide={props.onDecide}
    >
      {payload.native && <Text color={COLOR_WARNING}>{lines[0]}</Text>}
      <Text dimColor>{lines.at(-1)}</Text>
      <ScrollableModalText
        marginWhenSpacious
        maxRows={maxRows}
        scrollHint="scroll review"
        text={payload.review.join('\n')}
        width={width}
      />
    </ConfirmCard>
  );
}
