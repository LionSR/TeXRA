/**
 * Shared channel + latexdiff service instance for the latexdiff command group.
 *
 * A single module-scope instance is intentional (see the `LaTeXdiffService`
 * class): it constructs before `initPlatform()` runs and reads the timeout
 * per-diff via a thunk, so the value is never frozen at construction time.
 * The instance is exported as lowercase `latexdiffService` to distinguish it
 * from the `LaTeXdiffService` class it instantiates.
 */

import { LaTeXdiffService as LaTeXdiffServiceImpl } from '@latex/latexdiff';
import { LATEX_COMMANDS_CHANNEL } from '../latexLogging';

export const CHANNEL = LATEX_COMMANDS_CHANNEL;

export const latexdiffService = new LaTeXdiffServiceImpl(CHANNEL);
