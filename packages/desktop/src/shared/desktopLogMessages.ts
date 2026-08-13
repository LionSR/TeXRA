import { z } from 'zod';

export const DESKTOP_LOG_COMMANDS = {
  REQUEST_LOG: 'desktop:requestLog',
  SET_LOG: 'desktop:setLog',
  COPY_LOG: 'desktop:copyLog',
  EXPORT_LOG: 'desktop:exportLog',
} as const;

const DesktopLogSnapshotSchema = z.object({
  text: z.string(),
  truncated: z.boolean(),
  path: z.string().nullish(),
});

export const DesktopSetLogMessageSchema = z.object({
  command: z.literal(DESKTOP_LOG_COMMANDS.SET_LOG),
  log: DesktopLogSnapshotSchema,
});

export type DesktopLogSnapshot = z.infer<typeof DesktopLogSnapshotSchema>;
export type DesktopSetLogMessage = z.infer<typeof DesktopSetLogMessageSchema>;
