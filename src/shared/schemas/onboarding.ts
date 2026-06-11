/**
 * Onboarding-funnel wire schema (PRD: agent-native onboarding).
 *
 * The derivation lives in `@controllers/onboarding/onboardingFunnel`; this
 * schema is the canonical state shape hosts push to webviews, and the funnel
 * module derives its `OnboardingFunnelState` type from it so the wire format
 * and the domain type can never drift.
 */
import { z } from 'zod';

export const OnboardingFunnelStateSchema = z.enum([
  'needs-credential',
  'setup',
  'done',
]);
export type OnboardingFunnelState = z.infer<typeof OnboardingFunnelStateSchema>;
