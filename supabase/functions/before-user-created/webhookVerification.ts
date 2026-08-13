// Third-party imports
import { Webhook } from 'standardwebhooks';

const HOOK_SECRET_NAME = 'BEFORE_USER_CREATED_HOOK_SECRET';

/** Creates the hook verifier or prevents the worker from starting insecurely. */
export function createWebhookVerifier(rawSecret: string | undefined): Webhook {
  if (!rawSecret) {
    throw new Error(`${HOOK_SECRET_NAME} is required`);
  }

  // Supabase stores the secret as "v1,whsec_<base64>"; the library expects
  // either the Base64 value or its own "whsec_" prefix.
  const secret = rawSecret.replace(/^v1,whsec_/, '');

  try {
    return new Webhook(secret);
  } catch (cause) {
    throw new Error(`${HOOK_SECRET_NAME} is unusable`, { cause });
  }
}
