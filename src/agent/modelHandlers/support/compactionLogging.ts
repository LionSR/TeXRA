import { logContextManagementEvent, type AgentTrace } from '@agent/trace';
import { roundTo } from '@utils/core';

import { computeUtilizationPercent } from './contextUtilization';

interface LogCompactionEventOptions {
  readonly logger: AgentTrace;
  readonly tokensBefore: number;
  readonly tokensAfter: number;
  readonly contextWindow: number;
  readonly details: string;
  readonly tokensAfterIsEstimate?: boolean;
}

export function logCompactionEvent({
  logger,
  tokensBefore,
  tokensAfter,
  contextWindow,
  details,
  tokensAfterIsEstimate = false,
}: LogCompactionEventOptions): void {
  const reduction = tokensBefore - tokensAfter;
  const reductionPercent =
    tokensBefore > 0 ? ((reduction / tokensBefore) * 100).toFixed(1) : '0';
  const afterPrefix = tokensAfterIsEstimate ? '~' : '';

  logContextManagementEvent(
    logger,
    `Compacted conversation: ${tokensBefore.toLocaleString()} → ${afterPrefix}${tokensAfter.toLocaleString()} tokens (${reductionPercent}% reduction)`,
    {
      action: 'compaction',
      tokensBefore,
      tokensAfter,
      contextWindow,
      utilizationBefore: roundTo(
        computeUtilizationPercent(tokensBefore, contextWindow),
        1,
      ),
      utilizationAfter: roundTo(
        computeUtilizationPercent(tokensAfter, contextWindow),
        1,
      ),
      details,
    },
  );
}
