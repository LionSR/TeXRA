/**
 * Utility functions for chat message handling.
 *
 * This module re-exports from the centralized core module for backwards
 * compatibility. New code should import directly from '@utils/core'.
 */

// Re-export the centralized contentToString with legacy name
export { contentToString as convertContentToString } from '@utils/core';
