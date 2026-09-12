// Third-party imports
import { z } from 'zod';

// Local imports
import { RunUsageTotalsSchema } from '@shared/schemas';

export type RunUsageTotals = z.infer<typeof RunUsageTotalsSchema>;
