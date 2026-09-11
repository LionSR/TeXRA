/**
 * The prompt templates the runtime renders itself: the goal continuation and
 * the follow-up polish instruction. Both are inline, so they render in every
 * host and embedder with nothing to register at startup.
 */

/**
 * The goal continuation injected at the end of an idle turn while a goal is
 * active.
 */
export const GOAL_CONTINUATION_TEMPLATE =
  [
    '<goal_context>',
    'Autonomous objective active. Keep working until it is verifiably done.',
    'Do not end your turn to summarize progress or hand back control; only',
    "stop when the objective's end state is true and you have inspected real",
    'evidence for it. Persist even when a tool call or command fails:',
    'diagnose, adjust, and retry rather than yielding.',
    '',
    '<objective>',
    '{{objective}}',
    '</objective>',
    '',
    'Time elapsed: {{timeUsed}}',
    '',
    '- Do not redefine success around a smaller or easier task, and do not',
    '  substitute a narrower, safer, or merely test-passing solution for the',
    '  behavior the objective requests.',
    '- If you cannot finish this turn, make concrete progress and keep going.',
    '- Treat completion as unproven until you have inspected authoritative',
    '  evidence (file contents, command output, test results, runtime',
    "  behavior) for every requirement. Match the check's scope to the",
    "  requirement's scope, and gather stronger evidence when it is weak or",
    '  indirect.',
    '</goal_context>',
  ].join('\n') + '\n';

/**
 * The polish instruction. The raw user text is appended after it verbatim;
 * nothing is templated, so user text can't inject template syntax.
 */
export const POLISH_PROMPT_PREFIX =
  [
    'Correct any spelling errors, typos, grammatical mistakes, or punctuation ' +
      'issues. Preserve the original meaning and tone without adding new ' +
      'content or changing the structure unless necessary for clarity.',
    '',
    'Apply these formatting rules:',
    '1. If you spot inline LaTeX formulas, ensure they are wrapped with $ symbols (e.g., $E=mc^2$)',
    '2. If you spot XML tags, fix any unbalanced or unpaired tags',
    '3. If you spot Markdown syntax (like headers, lists, emphasis, links), fix any incorrect syntax',
    '',
    'Return the corrected text wrapped in <corrected_text> XML tags.',
    '',
    'Text to correct:',
  ].join('\n') + '\n';
