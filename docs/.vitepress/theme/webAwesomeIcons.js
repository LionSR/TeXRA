// Web Awesome icon registration for the VitePress site.
//
// Separate from the shared TypeScript registration because the statically
// built VitePress site cannot import the application boundary and supports a
// wider codicon-style alias vocabulary for markdown ergonomics, e.g.
// <wa-icon library="texra" name="sparkle"></wa-icon>.
//
// Imported from ./index.js for its side effects (calls registerIconLibrary
// once per page load).

import { faArrowDown } from '@fortawesome/free-solid-svg-icons/faArrowDown';
import { faArrowLeft } from '@fortawesome/free-solid-svg-icons/faArrowLeft';
import { faArrowRight } from '@fortawesome/free-solid-svg-icons/faArrowRight';
import { faArrowsRotate } from '@fortawesome/free-solid-svg-icons/faArrowsRotate';
import { faArrowUp } from '@fortawesome/free-solid-svg-icons/faArrowUp';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons/faArrowUpRightFromSquare';
import { faBolt } from '@fortawesome/free-solid-svg-icons/faBolt';
import { faBook } from '@fortawesome/free-solid-svg-icons/faBook';
import { faBox } from '@fortawesome/free-solid-svg-icons/faBox';
import { faBoxArchive } from '@fortawesome/free-solid-svg-icons/faBoxArchive';
import { faBullseye } from '@fortawesome/free-solid-svg-icons/faBullseye';
import { faChartLine } from '@fortawesome/free-solid-svg-icons/faChartLine';
import { faCheck } from '@fortawesome/free-solid-svg-icons/faCheck';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons/faChevronDown';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons/faChevronRight';
import { faChevronUp } from '@fortawesome/free-solid-svg-icons/faChevronUp';
import { faCircleCheck } from '@fortawesome/free-solid-svg-icons/faCircleCheck';
import { faCircleDot } from '@fortawesome/free-solid-svg-icons/faCircleDot';
import { faCircleExclamation } from '@fortawesome/free-solid-svg-icons/faCircleExclamation';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons/faCircleInfo';
import { faCircleStop } from '@fortawesome/free-solid-svg-icons/faCircleStop';
import { faCircleUser } from '@fortawesome/free-solid-svg-icons/faCircleUser';
import { faCircleXmark } from '@fortawesome/free-solid-svg-icons/faCircleXmark';
import { faClockRotateLeft } from '@fortawesome/free-solid-svg-icons/faClockRotateLeft';
import { faCloud } from '@fortawesome/free-solid-svg-icons/faCloud';
import { faCloudArrowDown } from '@fortawesome/free-solid-svg-icons/faCloudArrowDown';
import { faCloudArrowUp } from '@fortawesome/free-solid-svg-icons/faCloudArrowUp';
import { faCode } from '@fortawesome/free-solid-svg-icons/faCode';
import { faCodeBranch } from '@fortawesome/free-solid-svg-icons/faCodeBranch';
import { faCodeCompare } from '@fortawesome/free-solid-svg-icons/faCodeCompare';
import { faCodeMerge } from '@fortawesome/free-solid-svg-icons/faCodeMerge';
import { faCompass } from '@fortawesome/free-solid-svg-icons/faCompass';
import { faComment } from '@fortawesome/free-solid-svg-icons/faComment';
import { faComments } from '@fortawesome/free-solid-svg-icons/faComments';
import { faCopy } from '@fortawesome/free-solid-svg-icons/faCopy';
import { faCube } from '@fortawesome/free-solid-svg-icons/faCube';
import { faDatabase } from '@fortawesome/free-solid-svg-icons/faDatabase';
import { faDiagramProject } from '@fortawesome/free-solid-svg-icons/faDiagramProject';
import { faEllipsis } from '@fortawesome/free-solid-svg-icons/faEllipsis';
import { faEraser } from '@fortawesome/free-solid-svg-icons/faEraser';
import { faEye } from '@fortawesome/free-solid-svg-icons/faEye';
import { faFile } from '@fortawesome/free-solid-svg-icons/faFile';
import { faFileCirclePlus } from '@fortawesome/free-solid-svg-icons/faFileCirclePlus';
import { faFileCode } from '@fortawesome/free-solid-svg-icons/faFileCode';
import { faFileExport } from '@fortawesome/free-solid-svg-icons/faFileExport';
import { faFileLines } from '@fortawesome/free-solid-svg-icons/faFileLines';
import { faFilePdf } from '@fortawesome/free-solid-svg-icons/faFilePdf';
import { faFlask } from '@fortawesome/free-solid-svg-icons/faFlask';
import { faFloppyDisk } from '@fortawesome/free-solid-svg-icons/faFloppyDisk';
import { faFolder } from '@fortawesome/free-solid-svg-icons/faFolder';
import { faFolderOpen } from '@fortawesome/free-solid-svg-icons/faFolderOpen';
import { faFolderTree } from '@fortawesome/free-solid-svg-icons/faFolderTree';
import { faForwardStep } from '@fortawesome/free-solid-svg-icons/faForwardStep';
import { faGear } from '@fortawesome/free-solid-svg-icons/faGear';
import { faGlobe } from '@fortawesome/free-solid-svg-icons/faGlobe';
import { faGraduationCap } from '@fortawesome/free-solid-svg-icons/faGraduationCap';
import { faHashtag } from '@fortawesome/free-solid-svg-icons/faHashtag';
import { faImage } from '@fortawesome/free-solid-svg-icons/faImage';
import { faKey } from '@fortawesome/free-solid-svg-icons/faKey';
import { faLightbulb } from '@fortawesome/free-solid-svg-icons/faLightbulb';
import { faLink } from '@fortawesome/free-solid-svg-icons/faLink';
import { faListCheck } from '@fortawesome/free-solid-svg-icons/faListCheck';
import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons/faMagnifyingGlass';
import { faMicrophone } from '@fortawesome/free-solid-svg-icons/faMicrophone';
import { faNoteSticky } from '@fortawesome/free-solid-svg-icons/faNoteSticky';
import { faPalette } from '@fortawesome/free-solid-svg-icons/faPalette';
import { faPencil } from '@fortawesome/free-solid-svg-icons/faPencil';
import { faPlay } from '@fortawesome/free-solid-svg-icons/faPlay';
import { faPlus } from '@fortawesome/free-solid-svg-icons/faPlus';
import { faPlusMinus } from '@fortawesome/free-solid-svg-icons/faPlusMinus';
import { faReply } from '@fortawesome/free-solid-svg-icons/faReply';
import { faRightToBracket } from '@fortawesome/free-solid-svg-icons/faRightToBracket';
import { faRobot } from '@fortawesome/free-solid-svg-icons/faRobot';
import { faRocket } from '@fortawesome/free-solid-svg-icons/faRocket';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons/faRotateRight';
import { faRuler } from '@fortawesome/free-solid-svg-icons/faRuler';
import { faScrewdriverWrench } from '@fortawesome/free-solid-svg-icons/faScrewdriverWrench';
import { faServer } from '@fortawesome/free-solid-svg-icons/faServer';
import { faShield } from '@fortawesome/free-solid-svg-icons/faShield';
import { faTerminal } from '@fortawesome/free-solid-svg-icons/faTerminal';
import { faThumbtack } from '@fortawesome/free-solid-svg-icons/faThumbtack';
import { faThumbtackSlash } from '@fortawesome/free-solid-svg-icons/faThumbtackSlash';
import { faTrash } from '@fortawesome/free-solid-svg-icons/faTrash';
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons/faTriangleExclamation';
import { faUsers } from '@fortawesome/free-solid-svg-icons/faUsers';
import { faVideo } from '@fortawesome/free-solid-svg-icons/faVideo';
import { faVolumeHigh } from '@fortawesome/free-solid-svg-icons/faVolumeHigh';
import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons/faWandMagicSparkles';
import { faWrench } from '@fortawesome/free-solid-svg-icons/faWrench';
import { faXmark } from '@fortawesome/free-solid-svg-icons/faXmark';
import { registerIconLibrary } from '@awesome.me/webawesome/dist/components/icon/library.js';

export const TEXRA_ICON_LIBRARY = 'texra';

function iconSvg(iconDefinition) {
  const [width, height, , , svgPathData] = iconDefinition.icon;
  const paths = Array.isArray(svgPathData)
    ? svgPathData
        .map((path) => `<path fill="currentColor" d="${path}"/>`)
        .join('')
    : `<path fill="currentColor" d="${svgPathData}"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}">${paths}</svg>`;
}

// Canonical Font Awesome names. Use these directly when adding new icons.
const icons = {
  'arrow-down': faArrowDown,
  'arrow-left': faArrowLeft,
  'arrow-right': faArrowRight,
  'arrow-up': faArrowUp,
  'arrow-up-right-from-square': faArrowUpRightFromSquare,
  'arrows-rotate': faArrowsRotate,
  bolt: faBolt,
  book: faBook,
  bullseye: faBullseye,
  box: faBox,
  'box-archive': faBoxArchive,
  'chart-line': faChartLine,
  check: faCheck,
  'chevron-down': faChevronDown,
  'chevron-right': faChevronRight,
  'chevron-up': faChevronUp,
  'circle-check': faCircleCheck,
  'circle-dot': faCircleDot,
  'circle-exclamation': faCircleExclamation,
  'circle-info': faCircleInfo,
  'circle-stop': faCircleStop,
  'circle-user': faCircleUser,
  'circle-xmark': faCircleXmark,
  'clock-rotate-left': faClockRotateLeft,
  cloud: faCloud,
  'cloud-arrow-down': faCloudArrowDown,
  'cloud-arrow-up': faCloudArrowUp,
  code: faCode,
  'code-branch': faCodeBranch,
  'code-compare': faCodeCompare,
  'code-merge': faCodeMerge,
  comment: faComment,
  comments: faComments,
  compass: faCompass,
  copy: faCopy,
  cube: faCube,
  database: faDatabase,
  'diagram-project': faDiagramProject,
  ellipsis: faEllipsis,
  eraser: faEraser,
  eye: faEye,
  file: faFile,
  'file-circle-plus': faFileCirclePlus,
  'file-code': faFileCode,
  'file-export': faFileExport,
  'file-lines': faFileLines,
  'file-pdf': faFilePdf,
  flask: faFlask,
  'floppy-disk': faFloppyDisk,
  folder: faFolder,
  'folder-open': faFolderOpen,
  'folder-tree': faFolderTree,
  'forward-step': faForwardStep,
  gear: faGear,
  globe: faGlobe,
  'graduation-cap': faGraduationCap,
  hashtag: faHashtag,
  image: faImage,
  key: faKey,
  lightbulb: faLightbulb,
  link: faLink,
  'list-check': faListCheck,
  'magnifying-glass': faMagnifyingGlass,
  microphone: faMicrophone,
  'note-sticky': faNoteSticky,
  palette: faPalette,
  pencil: faPencil,
  play: faPlay,
  plus: faPlus,
  'plus-minus': faPlusMinus,
  reply: faReply,
  'right-to-bracket': faRightToBracket,
  robot: faRobot,
  rocket: faRocket,
  'rotate-right': faRotateRight,
  ruler: faRuler,
  'screwdriver-wrench': faScrewdriverWrench,
  server: faServer,
  shield: faShield,
  terminal: faTerminal,
  thumbtack: faThumbtack,
  'thumbtack-slash': faThumbtackSlash,
  trash: faTrash,
  'triangle-exclamation': faTriangleExclamation,
  users: faUsers,
  video: faVideo,
  'volume-high': faVolumeHigh,
  'wand-magic-sparkles': faWandMagicSparkles,
  wrench: faWrench,
  xmark: faXmark,
};

// Codicon-name aliases. Lets markdown keep using familiar codicon names
// (e.g. <wa-icon name="warning">) while resolving to the closest Font Awesome
// glyph in the registry above. Docs-site-only: there is no repo-wide
// codicon-alias table left to mirror (src/shared/wa/webAwesomeIcons.ts
// resolves TeXRAIconName directly, not codicon names).
const CODICON_ALIASES = {
  account: 'circle-user',
  add: 'plus',
  archive: 'box-archive',
  beaker: 'flask',
  'circle-slash': 'circle-xmark',
  'clear-all': 'eraser',
  clippy: 'copy',
  close: 'xmark',
  'cloud-download': 'cloud-arrow-down',
  'cloud-upload': 'cloud-arrow-up',
  'comment-discussion': 'comments',
  dashboard: 'gear',
  debug: 'play',
  'debug-alt': 'play',
  'debug-stop': 'circle-stop',
  'device-camera-video': 'video',
  diff: 'code-compare',
  'diff-multiple': 'plus-minus',
  'diff-single': 'plus-minus',
  edit: 'pencil',
  error: 'circle-exclamation',
  'file-add': 'file-circle-plus',
  'file-media': 'image',
  'file-submodule': 'folder-tree',
  'file-symlink-file': 'file-export',
  'file-text': 'file-lines',
  files: 'copy',
  'folder-opened': 'folder-open',
  github: 'code-branch',
  'git-commit': 'circle-dot',
  history: 'clock-rotate-left',
  info: 'circle-info',
  library: 'book',
  merge: 'code-merge',
  mic: 'microphone',
  'mortar-board': 'graduation-cap',
  'new-file': 'file-circle-plus',
  note: 'note-sticky',
  output: 'terminal',
  package: 'box',
  'play-circle': 'play',
  pulse: 'chart-line',
  refresh: 'rotate-right',
  save: 'floppy-disk',
  search: 'magnifying-glass',
  'settings-gear': 'gear',
  'sign-in': 'right-to-bracket',
  'source-control': 'code-branch',
  sparkle: 'wand-magic-sparkles',
  'symbol-color': 'palette',
  'symbol-keyword': 'key',
  'symbol-numeric': 'hashtag',
  'symbol-operator': 'cube',
  'symbol-ruler': 'ruler',
  'symbol-structure': 'diagram-project',
  'symbol-variable': 'code',
  sync: 'arrows-rotate',
  target: 'bullseye',
  tools: 'screwdriver-wrench',
  'type-hierarchy': 'diagram-project',
  unmute: 'volume-high',
  wand: 'wand-magic-sparkles',
  warning: 'triangle-exclamation',
};

let isRegistered = false;

function dataUri(svg) {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

function resolveIcon(name) {
  const aliased = CODICON_ALIASES[name];
  const canonical = aliased ?? name;
  return icons[canonical];
}

export function registerTeXRAWebAwesomeIcons() {
  if (isRegistered) return;

  registerIconLibrary(TEXRA_ICON_LIBRARY, {
    resolver(name) {
      const icon = resolveIcon(name);
      return icon ? dataUri(iconSvg(icon)) : '';
    },
  });
  isRegistered = true;
}
