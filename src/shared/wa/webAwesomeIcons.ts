// Third-party imports
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons/faArrowUpRightFromSquare';
import { faBackwardStep } from '@fortawesome/free-solid-svg-icons/faBackwardStep';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons/faChevronDown';
import { faChevronLeft } from '@fortawesome/free-solid-svg-icons/faChevronLeft';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons/faChevronRight';
import { faCloudArrowDown } from '@fortawesome/free-solid-svg-icons/faCloudArrowDown';
import { faForwardStep } from '@fortawesome/free-solid-svg-icons/faForwardStep';
import { faGear } from '@fortawesome/free-solid-svg-icons/faGear';
import { faKey } from '@fortawesome/free-solid-svg-icons/faKey';
import { faPencil } from '@fortawesome/free-solid-svg-icons/faPencil';
import { faPictureInPicture } from '@fortawesome/free-solid-svg-icons/faPictureInPicture';
import { faPlay } from '@fortawesome/free-solid-svg-icons/faPlay';
import { faRightToBracket } from '@fortawesome/free-solid-svg-icons/faRightToBracket';
import { faRobot } from '@fortawesome/free-solid-svg-icons/faRobot';
import { faTerminal } from '@fortawesome/free-solid-svg-icons/faTerminal';
import { faUser } from '@fortawesome/free-solid-svg-icons/faUser';
import { faXmark } from '@fortawesome/free-solid-svg-icons/faXmark';
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

export const TEXRA_ICON_LIBRARY = 'texra';

type FontAwesomePathData = string | string[];

interface FontAwesomeIconDefinition {
  readonly icon: readonly [
    width: number,
    height: number,
    ligatures: readonly (string | number)[],
    unicode: string,
    svgPathData: FontAwesomePathData,
  ];
}

function iconSvg(iconDefinition: FontAwesomeIconDefinition): string {
  const [width, height, , , svgPathData] = iconDefinition.icon;
  const paths = Array.isArray(svgPathData)
    ? svgPathData
        .map((path) => `<path fill="currentColor" d="${path}"/>`)
        .join('')
    : `<path fill="currentColor" d="${svgPathData}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${paths}</svg>`;
}

const icons = {
  // Font Awesome Free icons; Web Awesome renders them from local data URIs.
  'arrow-up-right-from-square': faArrowUpRightFromSquare,
  'backward-step': faBackwardStep,
  'chevron-down': faChevronDown,
  'chevron-left': faChevronLeft,
  'chevron-right': faChevronRight,
  'cloud-arrow-down': faCloudArrowDown,
  'forward-step': faForwardStep,
  gear: faGear,
  key: faKey,
  pencil: faPencil,
  'picture-in-picture': faPictureInPicture,
  play: faPlay,
  'right-to-bracket': faRightToBracket,
  robot: faRobot,
  terminal: faTerminal,
  user: faUser,
  xmark: faXmark,
} as const;

let isRegistered = false;

function dataUri(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function registerTeXRAWebAwesomeIcons(): void {
  if (isRegistered) return;

  registerIconLibrary(TEXRA_ICON_LIBRARY, {
    resolver(name) {
      const icon = icons[name as keyof typeof icons];
      return icon ? dataUri(iconSvg(icon)) : '';
    },
  });
  isRegistered = true;
}
