import { z } from 'zod';

/**
 * Any JSON-serializable value. Shared home for `z.json()` so structured tool
 * output, workflow-script persistence, and agent run results validate the
 * same contract instead of re-declaring it per module (#10279).
 */
export const JsonValueSchema = z.json();
export type JsonValue = z.infer<typeof JsonValueSchema>;
