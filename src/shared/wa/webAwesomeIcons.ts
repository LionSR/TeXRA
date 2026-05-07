// Third-party imports
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons/faArrowUpRightFromSquare';
import { faBackwardStep } from '@fortawesome/free-solid-svg-icons/faBackwardStep';
import { faBan } from '@fortawesome/free-solid-svg-icons/faBan';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons/faChevronDown';
import { faChevronLeft } from '@fortawesome/free-solid-svg-icons/faChevronLeft';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons/faChevronRight';
import { faChevronUp } from '@fortawesome/free-solid-svg-icons/faChevronUp';
import { faCircleUser } from '@fortawesome/free-solid-svg-icons/faCircleUser';
import { faClockRotateLeft } from '@fortawesome/free-solid-svg-icons/faClockRotateLeft';
import { faCloudArrowDown } from '@fortawesome/free-solid-svg-icons/faCloudArrowDown';
import { faCodeBranch } from '@fortawesome/free-solid-svg-icons/faCodeBranch';
import { faDatabase } from '@fortawesome/free-solid-svg-icons/faDatabase';
import { faFileExport } from '@fortawesome/free-solid-svg-icons/faFileExport';
import { faFileCode } from '@fortawesome/free-solid-svg-icons/faFileCode';
import { faFileLines } from '@fortawesome/free-solid-svg-icons/faFileLines';
import { faFilePdf } from '@fortawesome/free-solid-svg-icons/faFilePdf';
import { faFolderOpen } from '@fortawesome/free-solid-svg-icons/faFolderOpen';
import { faForwardStep } from '@fortawesome/free-solid-svg-icons/faForwardStep';
import { faGear } from '@fortawesome/free-solid-svg-icons/faGear';
import { faKey } from '@fortawesome/free-solid-svg-icons/faKey';
import { faPencil } from '@fortawesome/free-solid-svg-icons/faPencil';
import { faPictureInPicture } from '@fortawesome/free-solid-svg-icons/faPictureInPicture';
import { faPlay } from '@fortawesome/free-solid-svg-icons/faPlay';
import { faReply } from '@fortawesome/free-solid-svg-icons/faReply';
import { faRightFromBracket } from '@fortawesome/free-solid-svg-icons/faRightFromBracket';
import { faRightToBracket } from '@fortawesome/free-solid-svg-icons/faRightToBracket';
import { faRobot } from '@fortawesome/free-solid-svg-icons/faRobot';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons/faRotateRight';
import { faScrewdriverWrench } from '@fortawesome/free-solid-svg-icons/faScrewdriverWrench';
import { faServer } from '@fortawesome/free-solid-svg-icons/faServer';
import { faTerminal } from '@fortawesome/free-solid-svg-icons/faTerminal';
import { faThumbtack } from '@fortawesome/free-solid-svg-icons/faThumbtack';
import { faThumbtackSlash } from '@fortawesome/free-solid-svg-icons/faThumbtackSlash';
import { faTrash } from '@fortawesome/free-solid-svg-icons/faTrash';
import { faUser } from '@fortawesome/free-solid-svg-icons/faUser';
import { faUsers } from '@fortawesome/free-solid-svg-icons/faUsers';
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
  ban: faBan,
  'chevron-down': faChevronDown,
  'chevron-left': faChevronLeft,
  'chevron-right': faChevronRight,
  'chevron-up': faChevronUp,
  'circle-user': faCircleUser,
  'clock-rotate-left': faClockRotateLeft,
  'cloud-arrow-down': faCloudArrowDown,
  'code-branch': faCodeBranch,
  database: faDatabase,
  'file-code': faFileCode,
  'file-export': faFileExport,
  'file-lines': faFileLines,
  'file-pdf': faFilePdf,
  'folder-open': faFolderOpen,
  'forward-step': faForwardStep,
  gear: faGear,
  key: faKey,
  pencil: faPencil,
  'picture-in-picture': faPictureInPicture,
  play: faPlay,
  reply: faReply,
  'right-from-bracket': faRightFromBracket,
  'right-to-bracket': faRightToBracket,
  robot: faRobot,
  'rotate-right': faRotateRight,
  'screwdriver-wrench': faScrewdriverWrench,
  server: faServer,
  terminal: faTerminal,
  thumbtack: faThumbtack,
  'thumbtack-slash': faThumbtackSlash,
  trash: faTrash,
  user: faUser,
  users: faUsers,
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
