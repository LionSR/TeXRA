// Third-party imports
import { nanoid } from 'nanoid';

// Utility functions for frontend

/**
 * Generate a nonce string for Webview content security policies.
 * @param length Length of the generated nonce
 */

export function generateNonce(length = 32): string {
  return nanoid(length);
}
