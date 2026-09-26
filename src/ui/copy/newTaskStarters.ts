/**
 * The starter prompts on the empty New-task screen. Each one fills the
 * composer with an editable instruction instead of sending it: a starter
 * shows what a good request looks like, and the user still decides what to
 * run. Kept to the four jobs the hero has always named, so the screen offers
 * a short menu rather than a catalog.
 */

import type { TeXRAIconName } from '@ui/wa/iconNames';

interface NewTaskStarter {
  readonly id: string;
  readonly label: string;
  readonly icon: TeXRAIconName;
  readonly instruction: string;
}

export const NEW_TASK_STARTERS: readonly NewTaskStarter[] = [
  {
    id: 'polish',
    label: 'Polish the writing',
    icon: 'pencil',
    instruction:
      'Polish the writing of the introduction for clarity and concision. Keep the math, the claims, and the citations unchanged.',
  },
  {
    id: 'review',
    label: 'Review as a referee',
    icon: 'graduation-cap',
    instruction:
      'Review the paper as a critical referee: summarize the main claims, then list the weakest arguments, unclear passages, and missing references, most important first.',
  },
  {
    id: 'proof',
    label: 'Check a proof',
    icon: 'check-double',
    instruction:
      'Check the proofs in the main text step by step. Flag gaps, unstated assumptions, and errors, and suggest a fix for each.',
  },
  {
    id: 'literature',
    label: 'Find related work',
    icon: 'book',
    instruction:
      'Find recent related work the paper does not cite yet, and suggest where each reference belongs.',
  },
];
