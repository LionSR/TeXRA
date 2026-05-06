// Third-party imports
import { faBackwardStep } from '@fortawesome/free-solid-svg-icons/faBackwardStep';
import { faGear } from '@fortawesome/free-solid-svg-icons/faGear';
import { faKey } from '@fortawesome/free-solid-svg-icons/faKey';
import { faPencil } from '@fortawesome/free-solid-svg-icons/faPencil';
import { faPictureInPicture } from '@fortawesome/free-solid-svg-icons/faPictureInPicture';
import { faPlay } from '@fortawesome/free-solid-svg-icons/faPlay';
import { faRobot } from '@fortawesome/free-solid-svg-icons/faRobot';
import { faUser } from '@fortawesome/free-solid-svg-icons/faUser';
import { faXmark } from '@fortawesome/free-solid-svg-icons/faXmark';
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

const TEXRA_ICON_LIBRARY = 'texra';

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
  'backward-step': faBackwardStep,
  gear: faGear,
  key: faKey,
  pencil: faPencil,
  'picture-in-picture': faPictureInPicture,
  play: faPlay,
  robot: faRobot,
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

export { TEXRA_ICON_LIBRARY };
