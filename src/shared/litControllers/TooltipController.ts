import { clamp, createFlushableDebounce } from '@utils/core';

/**
 * Tooltip delay in ms before showing (matches VS Code native tooltip timing).
 */
const TOOLTIP_SHOW_DELAY_MS = 500;

const TOOLTIP_STYLES: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  padding: 'var(--wa-space-2xs, 4px) var(--wa-space-xs, 8px)',
  fontSize: 'var(--wa-font-size-m, 13px)',
  fontFamily: 'var(--wa-font-family-body, system-ui), system-ui',
  color: 'var(--wa-color-text-normal)',
  background: 'var(--wa-color-surface-raised, var(--wa-color-surface-default))',
  border: '1px solid var(--wa-color-surface-border, transparent)',
  borderRadius: 'var(--border-radius, 3px)',
  whiteSpace: 'nowrap',
  pointerEvents: 'none',
  zIndex: '10000',
  opacity: '0',
  transition: 'opacity var(--transition-fast, 0.15s ease)',
};

const TOOLTIP_TARGET_TAGS = new Set(['VSCODE-TOOLBAR-BUTTON', 'WA-BUTTON']);

/**
 * Find the nearest icon-only button with a title in a composed event path.
 * Works across shadow DOM boundaries.
 */
function findTooltipTarget(e: Event): Element | null {
  for (const el of e.composedPath()) {
    if (
      el instanceof Element &&
      TOOLTIP_TARGET_TAGS.has(el.tagName) &&
      el.hasAttribute('title')
    ) {
      return el;
    }
  }
  return null;
}

let tooltipEl: HTMLDivElement | null = null;
let currentTarget: Element | null = null;
let savedTitle = '';
let installed = false;

const showTimer = createFlushableDebounce(() => {
  if (currentTarget) show(currentTarget);
}, TOOLTIP_SHOW_DELAY_MS);

function show(anchor: Element): void {
  const text = anchor.getAttribute('title');
  if (!text) return;

  // Strip native title to prevent double tooltip
  savedTitle = text;
  anchor.removeAttribute('title');

  if (!tooltipEl) {
    tooltipEl = document.createElement('div');
    tooltipEl.setAttribute('role', 'tooltip');
    Object.assign(tooltipEl.style, TOOLTIP_STYLES);
  }

  tooltipEl.textContent = text;
  document.body.appendChild(tooltipEl);

  // Position below the button, centered (defer to ensure layout is computed)
  requestAnimationFrame(() => {
    if (!tooltipEl || !currentTarget) return;
    const rect = anchor.getBoundingClientRect();
    const tooltipRect = tooltipEl.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tooltipRect.width / 2;

    // Clamp to viewport edges
    const margin = 4;
    left = clamp(left, margin, window.innerWidth - tooltipRect.width - margin);

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${rect.bottom + 4}px`;
    tooltipEl.style.opacity = '1';
  });
}

function hide(): void {
  showTimer.cancel();
  // Restore the title only if no code changed it while the tooltip was shown.
  if (currentTarget && savedTitle && !currentTarget.hasAttribute('title')) {
    currentTarget.setAttribute('title', savedTitle);
  }
  savedTitle = '';
  currentTarget = null;
  if (tooltipEl) {
    tooltipEl.style.opacity = '0';
    tooltipEl.remove();
  }
}

function handleOver(e: Event): void {
  const target = findTooltipTarget(e);
  if (!target || target === currentTarget) return;

  // Skip buttons with text content (they're self-explanatory)
  if (target.textContent?.trim()) return;

  hide();
  currentTarget = target;
  showTimer.schedule();
}

function handleOut(e: Event): void {
  if (!currentTarget) return;

  // Check if mouse moved to a child of the current target (still inside)
  const related = (e as MouseEvent).relatedTarget as Node | null;
  if (related && currentTarget.contains(related)) return;

  hide();
}

/**
 * Install global toolbar button tooltips for the current document.
 *
 * Uses `mouseover`/`mouseout` (composed events that cross shadow DOM
 * boundaries) so a single listener handles all toolbar buttons regardless
 * of which Lit component renders them.
 *
 * Safe to call multiple times — installs at most once per document.
 */
export function installToolbarTooltips(): void {
  if (installed) return;
  installed = true;
  document.addEventListener('mouseover', handleOver, true);
  document.addEventListener('mouseout', handleOut, true);
}
