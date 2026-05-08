// Third-party imports
import '@awesome.me/webawesome/dist/components/button/button.js';
import '@awesome.me/webawesome/dist/components/icon/icon.js';
import { html, nothing, type TemplateResult } from 'lit';
import {
  Directive,
  PartType,
  directive,
  type ElementPart,
  type PartInfo,
} from 'lit/directive.js';
import { ifDefined } from 'lit/directives/if-defined.js';

// Local imports - Web Awesome
import { type TeXRAIconName, waIcon } from './webAwesomeIcons';

type ActionButtonAppearance = 'filled' | 'outlined' | 'plain';
type ActionButtonVariant = 'brand' | 'neutral';

export interface IconActionButtonOptions {
  readonly icon: TeXRAIconName;
  readonly label: string;
  readonly title?: string;
  readonly action?: string;
  readonly className?: string;
  readonly appearance?: ActionButtonAppearance;
  readonly variant?: ActionButtonVariant;
  readonly disabled?: boolean;
  /** Extra dataset attributes (rendered as data-<key>). Skipped when value is undefined. */
  readonly dataset?: Readonly<Record<string, string | undefined>>;
  readonly onClick?: (event: MouseEvent) => void;
}

class DatasetDirective extends Directive {
  constructor(partInfo: PartInfo) {
    super(partInfo);
    if (partInfo.type !== PartType.ELEMENT) {
      throw new Error('datasetDirective must be used as an element directive');
    }
  }

  override update(
    part: ElementPart,
    [data]: [Readonly<Record<string, string | undefined>> | undefined],
  ): unknown {
    const el = part.element as HTMLElement;
    if (data) {
      for (const [key, value] of Object.entries(data)) {
        if (value === undefined) {
          delete el.dataset[key];
        } else {
          el.dataset[key] = value;
        }
      }
    }
    return this.render(data);
  }

  override render(
    _data: Readonly<Record<string, string | undefined>> | undefined,
  ): unknown {
    return nothing;
  }
}

const datasetDirective = directive(DatasetDirective);

export interface LabeledActionButtonOptions extends IconActionButtonOptions {
  readonly text: string;
}

function renderActionButtonBase({
  icon,
  label,
  text,
  title,
  action,
  className,
  appearance = 'outlined',
  variant = 'neutral',
  disabled,
  dataset,
  onClick,
}: IconActionButtonOptions & { readonly text?: string }): TemplateResult {
  const classes = [text ? 'action-button' : 'action-icon-button', className]
    .filter(Boolean)
    .join(' ');

  return html`
    <wa-button
      class=${classes}
      appearance=${appearance}
      variant=${variant}
      size="small"
      type="button"
      aria-label=${label}
      title=${title ?? label}
      data-action=${ifDefined(action)}
      ${datasetDirective(dataset)}
      ?disabled=${disabled}
      @click=${onClick}
    >
      ${waIcon(icon, { slot: text ? 'start' : undefined })} ${text}
    </wa-button>
  `;
}

export function renderIconActionButton(
  options: IconActionButtonOptions,
): TemplateResult {
  return renderActionButtonBase(options);
}

export function renderLabeledActionButton(
  options: LabeledActionButtonOptions,
): TemplateResult {
  return renderActionButtonBase(options);
}
