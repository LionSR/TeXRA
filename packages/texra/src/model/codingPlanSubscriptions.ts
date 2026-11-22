import { providerRegionSetting } from '@texra-ai/harness/schemas';
import {
  CODING_PLAN_SUBSCRIPTIONS,
  type CodingPlanSubscription,
} from '@texra/shared/model/codingPlans';

/**
 * The plan whose usage endpoint varies with the setting `key`: a plan's
 * usage is read on its provider's region, so its region toggle is that
 * setting (the GLM Coding Plan on `texra.glm.useChina`).
 */
export function codingPlanForUsageSetting(
  key: string,
): CodingPlanSubscription | undefined {
  return CODING_PLAN_SUBSCRIPTIONS.find(
    (plan) => providerRegionSetting(plan.apiProvider)?.key === key,
  );
}
