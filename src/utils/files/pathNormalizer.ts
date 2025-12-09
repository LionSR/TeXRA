/**
 * Path normalization utilities.
 *
 * This module re-exports from the centralized pathCore module for backwards
 * compatibility. New code should import directly from '@utils/core'.
 *
 * @module pathNormalizer
 */

// Re-export core path utilities for backwards compatibility
export {
  normalizeRelativePath as normalizeRunRelative,
  decodePathComponent,
  isSafePathSegment,
} from '@utils/core';
