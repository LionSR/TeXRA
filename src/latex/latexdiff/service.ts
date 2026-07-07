/**
 * Shared channel + LaTeXdiffService instance for the latexdiff command group.
 *
 * A single module-scope instance is intentional (see LaTeXdiffService): it
 * constructs before `initPlatform()` runs and reads the timeout per-diff via a
 * thunk, so the value is never frozen at construction time.
 */

import { LaTeXdiffService as LaTeXdiffServiceImpl } from '@latex/latexdiff';
import * as logger from '@logger/logUtils';

export const CHANNEL = 'LaTeXCommands';

logger.initialize(CHANNEL);

export const LaTeXdiffService = new LaTeXdiffServiceImpl(CHANNEL);
