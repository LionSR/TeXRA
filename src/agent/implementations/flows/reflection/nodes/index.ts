/**
 * Reflection flow nodes.
 *
 * These nodes implement the pure PocketFlow pattern for reflection agents:
 * - Services are injected via _params.services
 * - Nodes do the work, not agent methods
 * - ResponseCycleFlow is composed as a sub-flow
 *
 * Node flow:
 * PrepareContextNode → TeXCountNode → MediaPreparationNode
 *   → ResponseCycleCompositionNode → OutputNode → RoundCompleteNode
 *
 * PrepareContextNode is the first node in each round - it builds base messages.
 * Each subsequent node enriches the context:
 * - TeXCountNode: prepends LaTeX word count stats
 * - MediaPreparationNode: adds media files (figures, TikZ, PDFs)
 */

export { TeXCountNode } from './TeXCountNode';
export { MediaPreparationNode } from './MediaPreparationNode';
export { PrepareContextNode } from './PrepareContextNode';
export { ResponseCycleCompositionNode } from './ResponseCycleCompositionNode';
export { OutputNode } from './OutputNode';
export { RoundCompleteNode } from './RoundCompleteNode';
