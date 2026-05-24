// Subagent progress/result/error blocks (produced by src/tools/subagentResults.ts)
// are FollowUpQueue messages addressed to the orchestrator *model*, injected
// into the conversation as user turns. Rendering the raw XML in the human
// transcript is noise — the orchestrator's own prose already narrates the
// outcome — so collapse each block to a terse status line. Text that is not a
// subagent block passes through unchanged.

const SUBAGENT_TAG_RE = /^<subagent-(?:progress|result|error)\b/;

function attr(xml: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1];
}

function innerTag(xml: string, tag: string): string | undefined {
  return new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1]?.trim();
}

function progressDetail(xml: string): string {
  switch (attr(xml, 'type')) {
    case 'started':
      return 'started';
    case 'overview': {
      const calls = attr(xml, 'tool-calls');
      const cost = attr(xml, 'cost');
      const parts: string[] = [];
      if (calls) parts.push(`${calls} tool call${calls === '1' ? '' : 's'}`);
      if (cost) parts.push(`$${cost}`);
      return parts.length > 0 ? parts.join(' · ') : 'working';
    }
    case 'round': {
      const current = attr(xml, 'current');
      const total = attr(xml, 'total');
      return current && total ? `round ${current}/${total}` : 'working';
    }
    case 'plan':
      return attr(xml, 'status') === 'cleared'
        ? 'plan cleared'
        : `plan · ${attr(xml, 'steps') ?? '0'} steps`;
    case 'todos':
      return `todos · ${attr(xml, 'completed') ?? '0'} done, ${attr(xml, 'active') ?? '0'} active, ${attr(xml, 'pending') ?? '0'} pending`;
    default:
      return 'working';
  }
}

/**
 * Collapse a subagent follow-up XML block into a one-line (or, for results,
 * status + response) human-readable summary. Returns `text` unchanged when it
 * is not a subagent block.
 */
export function summarizeSubagentFollowup(text: string): string {
  const trimmed = text.trim();
  if (!SUBAGENT_TAG_RE.test(trimmed)) return text;

  const agent = attr(trimmed, 'agent') ?? 'subagent';

  if (trimmed.startsWith('<subagent-progress')) {
    return `⟳ ${agent} · ${progressDetail(trimmed)}`;
  }

  if (trimmed.startsWith('<subagent-result')) {
    const status = attr(trimmed, 'status') ?? 'completed';
    const wall = innerTag(trimmed, 'wall-time');
    const response = innerTag(trimmed, 'response');
    const head = `✓ ${agent} ${status}${wall ? ` · ${wall}` : ''}`;
    return response ? `${head}\n${response}` : head;
  }

  // <subagent-error>
  const wall = innerTag(trimmed, 'wall-time');
  const retryable = attr(trimmed, 'retryable') === 'true';
  return `✗ ${agent} failed${wall ? ` · ${wall}` : ''}${retryable ? ' (retryable)' : ''}`;
}
