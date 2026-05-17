import { z } from 'zod';

export const DESKTOP_SETUP_TERMINAL_COMMANDS = {
  SHOW: 'desktop:setupTerminalShow',
  APPEND: 'desktop:setupTerminalAppend',
  COMPLETE: 'desktop:setupTerminalComplete',
  CANCEL: 'desktop:setupTerminalCancel',
} as const;

const DesktopSetupTerminalStatusSchema = z.enum([
  'running',
  'succeeded',
  'failed',
  'timed-out',
  'cancelled',
]);

export type DesktopSetupTerminalStatus = z.infer<
  typeof DesktopSetupTerminalStatusSchema
>;

const DesktopSetupTerminalFinalStatusSchema =
  DesktopSetupTerminalStatusSchema.exclude(['running']);

const DesktopSetupTerminalBaseSchema = z.object({
  runId: z.string().min(1),
});

export const DesktopSetupTerminalShowMessageSchema =
  DesktopSetupTerminalBaseSchema.extend({
    command: z.literal(DESKTOP_SETUP_TERMINAL_COMMANDS.SHOW),
    title: z.string().min(1),
    shellCommand: z.string().min(1),
    cwd: z.string().min(1),
  });

export type DesktopSetupTerminalShowMessage = z.infer<
  typeof DesktopSetupTerminalShowMessageSchema
>;

export const DesktopSetupTerminalAppendMessageSchema =
  DesktopSetupTerminalBaseSchema.extend({
    command: z.literal(DESKTOP_SETUP_TERMINAL_COMMANDS.APPEND),
    stream: z.enum(['stdout', 'stderr']),
    chunk: z.string(),
  });

export type DesktopSetupTerminalAppendMessage = z.infer<
  typeof DesktopSetupTerminalAppendMessageSchema
>;

export const DesktopSetupTerminalCompleteMessageSchema =
  DesktopSetupTerminalBaseSchema.extend({
    command: z.literal(DESKTOP_SETUP_TERMINAL_COMMANDS.COMPLETE),
    status: DesktopSetupTerminalFinalStatusSchema,
    exitCode: z.int().nullish(),
    output: z.string(),
  });

export type DesktopSetupTerminalCompleteMessage = z.infer<
  typeof DesktopSetupTerminalCompleteMessageSchema
>;

export const DesktopSetupTerminalCancelMessageSchema =
  DesktopSetupTerminalBaseSchema.extend({
    command: z.literal(DESKTOP_SETUP_TERMINAL_COMMANDS.CANCEL),
  });

export type DesktopSetupTerminalCancelMessage = z.infer<
  typeof DesktopSetupTerminalCancelMessageSchema
>;

export function buildDesktopSetupTerminalShowMessage(
  payload: Omit<DesktopSetupTerminalShowMessage, 'command'>,
): DesktopSetupTerminalShowMessage {
  return {
    command: DESKTOP_SETUP_TERMINAL_COMMANDS.SHOW,
    ...payload,
  };
}

export function buildDesktopSetupTerminalAppendMessage(
  payload: Omit<DesktopSetupTerminalAppendMessage, 'command'>,
): DesktopSetupTerminalAppendMessage {
  return {
    command: DESKTOP_SETUP_TERMINAL_COMMANDS.APPEND,
    ...payload,
  };
}

export function buildDesktopSetupTerminalCompleteMessage(
  payload: Omit<DesktopSetupTerminalCompleteMessage, 'command'>,
): DesktopSetupTerminalCompleteMessage {
  return {
    command: DESKTOP_SETUP_TERMINAL_COMMANDS.COMPLETE,
    ...payload,
  };
}

export function buildDesktopSetupTerminalCancelMessage(
  runId: string,
): DesktopSetupTerminalCancelMessage {
  return {
    command: DESKTOP_SETUP_TERMINAL_COMMANDS.CANCEL,
    runId,
  };
}
