/**
 * The runs the validation model scripts its golden conversations for
 * (`validationModel.ts`), each as a launch writes it: its display name, its
 * system text, whose marker (`GOLDEN-PARENT`, …) picks the conversation, and
 * the tools it declares. The golden-store generator, the run validation and
 * the kernel suites start them; Node strips this file's types when a script
 * imports it.
 */

/** A run a validation launch starts in place of the entry agent. */
export interface ValidationAgent {
  readonly label: string;
  readonly system: string;
  readonly tools: readonly string[];
}

const agent = (
  label: string,
  system: string,
  tools: readonly string[] = [],
): ValidationAgent => Object.freeze({ label, system, tools });

export const GOLDEN_AGENTS = Object.freeze({
  /** The interactive chat, run as a goal, switched mid-run, and stopped
   *  over a Codex child. */
  golden_chat: agent(
    'golden_chat',
    'GOLDEN-CHAT: plan, run the plan as a goal, complete it.',
    ['plan', 'codex', 'bash'],
  ),
  /** The child, delegated to and deleted. */
  golden_child: agent('golden_child', 'GOLDEN-CHILD: answer the task.', [
    'executions',
  ]),
  /** The crash-point conformance run, truncated after each of its commits
   *  and resumed. */
  golden_crash: agent(
    'golden_crash',
    'GOLDEN-CRASH: two calls, an edit of the file they read, then a script with an owned child.',
    ['read_file', 'edit_file', 'bash', 'agent', 'script'],
  ),
  /** The delivery run: a detached child, a background script that awaits a
   *  child of its own, and a background command, each reporting back. */
  golden_delivery: agent(
    'golden_delivery',
    'GOLDEN-DELIVERY: send three children off, then read what they report.',
    ['agent', 'script', 'bash'],
  ),
  /** The run killed after its command's effect and before its result
   *  committed. */
  golden_effect: agent('golden_effect', 'GOLDEN-APPROVAL: run one command.', [
    'bash',
  ]),
  /** The forked conversation. */
  golden_fork: agent('golden_fork', 'GOLDEN-FORK: say what you were shown.'),
  /** The tool-use parent. */
  golden_parent: agent(
    'golden_parent',
    'GOLDEN-PARENT: read the notes, plan, delegate.',
    ['read_file', 'plan', 'agent', 'executions'],
  ),
  /** The script run, which finds its read tool, gathers in one script, and
   *  writes a child there. */
  golden_script: agent(
    'golden_script',
    'GOLDEN-SCRIPT: gather in one script.',
    ['read_file', 'bash', 'script', 'agent'],
  ),
});
