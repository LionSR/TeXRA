import { z } from 'zod';

export const DESKTOP_ONBOARDING_DISMISSED_STATE_KEY =
  'texra.desktop.hideStartupTeamChooser';

export const DESKTOP_ONBOARDING_COMMANDS = {
  REQUEST_STATE: 'desktop:requestOnboarding',
  DISMISS: 'desktop:dismissOnboarding',
  SET_STATE: 'desktop:setOnboarding',
} as const;

export const DesktopOnboardingSetStateMessageSchema = z.object({
  command: z.literal(DESKTOP_ONBOARDING_COMMANDS.SET_STATE),
  shouldShow: z.boolean(),
});

export type DesktopOnboardingSetStateMessage = z.infer<
  typeof DesktopOnboardingSetStateMessageSchema
>;

export function buildDesktopOnboardingSetStateMessage(
  shouldShow: boolean,
): DesktopOnboardingSetStateMessage {
  return {
    command: DESKTOP_ONBOARDING_COMMANDS.SET_STATE,
    shouldShow,
  };
}
