/**
 * How much a task does without asking, chosen when it starts. Autonomy and
 * the human in the loop are one dial, not two features: an Autonomous task
 * approves its own edits, commands and subagent work, and the run header
 * keeps the switch in view so the user can take it back mid-run. The Block
 * approval policy still wins over both.
 */
export const AUTONOMY = {
  title: 'Autonomy',
  ask: {
    label: 'Ask me',
    detail: 'before edits and commands',
    description:
      'Pause for your approval before file edits, shell commands and subagent work, as your approval policy says.',
  },
  autonomous: {
    label: 'Autonomous',
    detail: 'stop it anytime',
    description:
      'Approve its own file edits, shell commands and subagent work. Switch it off from the run header at any time; the Block policy still applies.',
  },
} as const;
