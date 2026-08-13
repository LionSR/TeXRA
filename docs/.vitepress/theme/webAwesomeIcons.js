// Web Awesome icon registration for the VitePress site.
//
// Mirrors the codicon -> Font Awesome alias map used by the rest of the TeXRA
// repo (see src/shared/wa/webAwesomeIcons.ts) so markdown that says
//   <wa-icon library="texra" name="sparkle"></wa-icon>
// resolves to the closest Font Awesome glyph.
//
// Imported from ./index.js for its side effects (calls registerIconLibrary
// once per page load).

import { faArrowDown } from '@fortawesome/free-solid-svg-icons/faArrowDown';
import { faArrowLeft } from '@fortawesome/free-solid-svg-icons/faArrowLeft';
import { faArrowRight } from '@fortawesome/free-solid-svg-icons/faArrowRight';
import { faArrowRotateLeft } from '@fortawesome/free-solid-svg-icons/faArrowRotateLeft';
import { faArrowsRotate } from '@fortawesome/free-solid-svg-icons/faArrowsRotate';
import { faArrowUp } from '@fortawesome/free-solid-svg-icons/faArrowUp';
import { faArrowUpRightFromSquare } from '@fortawesome/free-solid-svg-icons/faArrowUpRightFromSquare';
import { faBackwardStep } from '@fortawesome/free-solid-svg-icons/faBackwardStep';
import { faBan } from '@fortawesome/free-solid-svg-icons/faBan';
import { faBolt } from '@fortawesome/free-solid-svg-icons/faBolt';
import { faBook } from '@fortawesome/free-solid-svg-icons/faBook';
import { faBookmark } from '@fortawesome/free-solid-svg-icons/faBookmark';
import { faBox } from '@fortawesome/free-solid-svg-icons/faBox';
import { faBoxArchive } from '@fortawesome/free-solid-svg-icons/faBoxArchive';
import { faBuilding } from '@fortawesome/free-solid-svg-icons/faBuilding';
import { faBullseye } from '@fortawesome/free-solid-svg-icons/faBullseye';
import { faCaretDown } from '@fortawesome/free-solid-svg-icons/faCaretDown';
import { faChartLine } from '@fortawesome/free-solid-svg-icons/faChartLine';
import { faChartPie } from '@fortawesome/free-solid-svg-icons/faChartPie';
import { faCheck } from '@fortawesome/free-solid-svg-icons/faCheck';
import { faCheckDouble } from '@fortawesome/free-solid-svg-icons/faCheckDouble';
import { faChevronDown } from '@fortawesome/free-solid-svg-icons/faChevronDown';
import { faChevronLeft } from '@fortawesome/free-solid-svg-icons/faChevronLeft';
import { faChevronRight } from '@fortawesome/free-solid-svg-icons/faChevronRight';
import { faChevronUp } from '@fortawesome/free-solid-svg-icons/faChevronUp';
import { faCircle } from '@fortawesome/free-solid-svg-icons/faCircle';
import { faCircleCheck } from '@fortawesome/free-solid-svg-icons/faCircleCheck';
import { faCircleDot } from '@fortawesome/free-solid-svg-icons/faCircleDot';
import { faCircleExclamation } from '@fortawesome/free-solid-svg-icons/faCircleExclamation';
import { faCircleInfo } from '@fortawesome/free-solid-svg-icons/faCircleInfo';
import { faCircleQuestion } from '@fortawesome/free-solid-svg-icons/faCircleQuestion';
import { faCircleStop } from '@fortawesome/free-solid-svg-icons/faCircleStop';
import { faCircleUser } from '@fortawesome/free-solid-svg-icons/faCircleUser';
import { faCircleXmark } from '@fortawesome/free-solid-svg-icons/faCircleXmark';
import { faClock } from '@fortawesome/free-solid-svg-icons/faClock';
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
import { faDownload } from '@fortawesome/free-solid-svg-icons/faDownload';
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
import { faHeart } from '@fortawesome/free-solid-svg-icons/faHeart';
import { faImage } from '@fortawesome/free-solid-svg-icons/faImage';
import { faKey } from '@fortawesome/free-solid-svg-icons/faKey';
import { faLayerGroup } from '@fortawesome/free-solid-svg-icons/faLayerGroup';
import { faLightbulb } from '@fortawesome/free-solid-svg-icons/faLightbulb';
import { faLink } from '@fortawesome/free-solid-svg-icons/faLink';
import { faListCheck } from '@fortawesome/free-solid-svg-icons/faListCheck';
import { faListUl } from '@fortawesome/free-solid-svg-icons/faListUl';
import { faMagnifyingGlass } from '@fortawesome/free-solid-svg-icons/faMagnifyingGlass';
import { faMagnifyingGlassChart } from '@fortawesome/free-solid-svg-icons/faMagnifyingGlassChart';
import { faMicrophone } from '@fortawesome/free-solid-svg-icons/faMicrophone';
import { faMinus } from '@fortawesome/free-solid-svg-icons/faMinus';
import { faNoteSticky } from '@fortawesome/free-solid-svg-icons/faNoteSticky';
import { faPalette } from '@fortawesome/free-solid-svg-icons/faPalette';
import { faPaperPlane } from '@fortawesome/free-solid-svg-icons/faPaperPlane';
import { faPencil } from '@fortawesome/free-solid-svg-icons/faPencil';
import { faPictureInPicture } from '@fortawesome/free-solid-svg-icons/faPictureInPicture';
import { faPlay } from '@fortawesome/free-solid-svg-icons/faPlay';
import { faPlus } from '@fortawesome/free-solid-svg-icons/faPlus';
import { faPlusMinus } from '@fortawesome/free-solid-svg-icons/faPlusMinus';
import { faReply } from '@fortawesome/free-solid-svg-icons/faReply';
import { faRightFromBracket } from '@fortawesome/free-solid-svg-icons/faRightFromBracket';
import { faRightToBracket } from '@fortawesome/free-solid-svg-icons/faRightToBracket';
import { faRobot } from '@fortawesome/free-solid-svg-icons/faRobot';
import { faRocket } from '@fortawesome/free-solid-svg-icons/faRocket';
import { faRotateRight } from '@fortawesome/free-solid-svg-icons/faRotateRight';
import { faRuler } from '@fortawesome/free-solid-svg-icons/faRuler';
import { faScrewdriverWrench } from '@fortawesome/free-solid-svg-icons/faScrewdriverWrench';
import { faServer } from '@fortawesome/free-solid-svg-icons/faServer';
import { faShield } from '@fortawesome/free-solid-svg-icons/faShield';
import { faSpinner } from '@fortawesome/free-solid-svg-icons/faSpinner';
import { faTerminal } from '@fortawesome/free-solid-svg-icons/faTerminal';
import { faThumbtack } from '@fortawesome/free-solid-svg-icons/faThumbtack';
import { faThumbtackSlash } from '@fortawesome/free-solid-svg-icons/faThumbtackSlash';
import { faTrash } from '@fortawesome/free-solid-svg-icons/faTrash';
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons/faTriangleExclamation';
import { faUser } from '@fortawesome/free-solid-svg-icons/faUser';
import { faUsers } from '@fortawesome/free-solid-svg-icons/faUsers';
import { faVideo } from '@fortawesome/free-solid-svg-icons/faVideo';
import { faVolumeHigh } from '@fortawesome/free-solid-svg-icons/faVolumeHigh';
import { faWandMagicSparkles } from '@fortawesome/free-solid-svg-icons/faWandMagicSparkles';
import { faWindowMaximize } from '@fortawesome/free-solid-svg-icons/faWindowMaximize';
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
  'arrow-rotate-left': faArrowRotateLeft,
  'arrow-up': faArrowUp,
  'arrow-up-right-from-square': faArrowUpRightFromSquare,
  'arrows-rotate': faArrowsRotate,
  'backward-step': faBackwardStep,
  ban: faBan,
  bolt: faBolt,
  book: faBook,
  bookmark: faBookmark,
  bullseye: faBullseye,
  box: faBox,
  'box-archive': faBoxArchive,
  building: faBuilding,
  'caret-down': faCaretDown,
  'chart-line': faChartLine,
  'chart-pie': faChartPie,
  check: faCheck,
  'check-double': faCheckDouble,
  'chevron-down': faChevronDown,
  'chevron-left': faChevronLeft,
  'chevron-right': faChevronRight,
  'chevron-up': faChevronUp,
  circle: faCircle,
  'circle-check': faCircleCheck,
  'circle-dot': faCircleDot,
  'circle-exclamation': faCircleExclamation,
  'circle-info': faCircleInfo,
  'circle-question': faCircleQuestion,
  'circle-stop': faCircleStop,
  'circle-user': faCircleUser,
  'circle-xmark': faCircleXmark,
  clock: faClock,
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
  download: faDownload,
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
  heart: faHeart,
  image: faImage,
  key: faKey,
  'layer-group': faLayerGroup,
  lightbulb: faLightbulb,
  link: faLink,
  'list-check': faListCheck,
  'list-ul': faListUl,
  'magnifying-glass': faMagnifyingGlass,
  'magnifying-glass-chart': faMagnifyingGlassChart,
  microphone: faMicrophone,
  minus: faMinus,
  'note-sticky': faNoteSticky,
  palette: faPalette,
  'paper-plane': faPaperPlane,
  pencil: faPencil,
  'picture-in-picture': faPictureInPicture,
  play: faPlay,
  plus: faPlus,
  'plus-minus': faPlusMinus,
  reply: faReply,
  'right-from-bracket': faRightFromBracket,
  'right-to-bracket': faRightToBracket,
  robot: faRobot,
  rocket: faRocket,
  'rotate-right': faRotateRight,
  ruler: faRuler,
  'screwdriver-wrench': faScrewdriverWrench,
  server: faServer,
  shield: faShield,
  spinner: faSpinner,
  terminal: faTerminal,
  thumbtack: faThumbtack,
  'thumbtack-slash': faThumbtackSlash,
  trash: faTrash,
  'triangle-exclamation': faTriangleExclamation,
  user: faUser,
  users: faUsers,
  video: faVideo,
  'volume-high': faVolumeHigh,
  'wand-magic-sparkles': faWandMagicSparkles,
  'window-maximize': faWindowMaximize,
  wrench: faWrench,
  xmark: faXmark,
};

// Codicon-name aliases. Lets markdown keep using familiar codicon names
// (e.g. <wa-icon name="warning">) while resolving to the closest Font Awesome
// glyph in the registry above. Mirrors src/shared/wa/webAwesomeIcons.ts.
const CODICON_ALIASES = {
  account: 'circle-user',
  add: 'plus',
  archive: 'box-archive',
  'arrow-small-down': 'caret-down',
  beaker: 'flask',
  'check-all': 'check-double',
  checklist: 'list-check',
  'circle-large-outline': 'circle',
  'circle-outline': 'circle',
  'circle-slash': 'circle-xmark',
  'clear-all': 'eraser',
  clippy: 'copy',
  close: 'xmark',
  'close-all': 'eraser',
  'cloud-download': 'cloud-arrow-down',
  'cloud-upload': 'cloud-arrow-up',
  'comment-discussion': 'comments',
  dash: 'minus',
  dashboard: 'gear',
  debug: 'play',
  'debug-alt': 'play',
  'debug-continue': 'forward-step',
  'debug-rerun': 'rotate-right',
  'debug-start': 'play',
  'debug-stop': 'circle-stop',
  'desktop-download': 'download',
  'device-camera-video': 'video',
  diff: 'code-compare',
  'diff-added': 'plus',
  'diff-multiple': 'plus-minus',
  'diff-single': 'plus-minus',
  discard: 'arrow-rotate-left',
  edit: 'pencil',
  error: 'circle-exclamation',
  'file-add': 'file-circle-plus',
  'file-media': 'image',
  'file-submodule': 'folder-tree',
  'file-symlink-file': 'file-export',
  'file-text': 'file-lines',
  files: 'copy',
  fold: 'chevron-up',
  'folder-library': 'folder-tree',
  'folder-opened': 'folder-open',
  'folder-submodule': 'folder-tree',
  github: 'code-branch',
  'git-commit': 'circle-dot',
  'git-merge': 'code-merge',
  graph: 'chart-line',
  'graph-line': 'chart-line',
  history: 'clock-rotate-left',
  info: 'circle-info',
  inspect: 'magnifying-glass-chart',
  'layout-sidebar-right': 'window-maximize',
  'link-external': 'arrow-up-right-from-square',
  library: 'book',
  'list-tree': 'list-ul',
  'list-unordered': 'list-ul',
  loading: 'spinner',
  merge: 'code-merge',
  mic: 'microphone',
  'mortar-board': 'graduation-cap',
  'new-file': 'file-circle-plus',
  note: 'note-sticky',
  organization: 'building',
  output: 'terminal',
  package: 'box',
  'pass-filled': 'circle-check',
  'pie-chart': 'chart-pie',
  'play-circle': 'play',
  pulse: 'chart-line',
  question: 'circle-question',
  references: 'link',
  refresh: 'rotate-right',
  save: 'floppy-disk',
  search: 'magnifying-glass',
  send: 'paper-plane',
  'server-process': 'server',
  'settings-gear': 'gear',
  'sign-in': 'right-to-bracket',
  'sign-out': 'right-from-bracket',
  'source-control': 'code-branch',
  sparkle: 'wand-magic-sparkles',
  'stop-circle': 'circle-stop',
  stylesheet: 'palette',
  'symbol-color': 'palette',
  'symbol-keyword': 'key',
  'symbol-method': 'cube',
  'symbol-number': 'hashtag',
  'symbol-numeric': 'hashtag',
  'symbol-operator': 'cube',
  'symbol-ruler': 'ruler',
  'symbol-structure': 'diagram-project',
  'symbol-variable': 'code',
  sync: 'arrows-rotate',
  target: 'bullseye',
  tasklist: 'list-check',
  tools: 'screwdriver-wrench',
  'type-hierarchy': 'diagram-project',
  unmute: 'volume-high',
  wand: 'wand-magic-sparkles',
  warning: 'triangle-exclamation',
  window: 'window-maximize',
  x: 'xmark',
  zap: 'bolt',
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
