/**
 * Inline SVG icon set (16x16 grid, stroke icons, currentColor) — no icon font or library.
 */
import type { SVGProps } from 'react';

const PATHS = {
  play: 'M5 3.5v9l7.5-4.5z',
  pause: 'M5 3.5v9M11 3.5v9',
  toStart: 'M4 3.5v9M12 3.5v9L5.5 8z',
  stepBack: 'M11.5 3.5v9L5 8zM4 3.5v9',
  stepFwd: 'M4.5 3.5v9L11 8zM12 3.5v9',
  repeat: 'M3 7V6a2 2 0 0 1 2-2h7.5M10.5 2l2 2-2 2M13 9v1a2 2 0 0 1-2 2H3.5M5.5 14l-2-2 2-2',
  eye: 'M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  eyeOff: 'M2 2l12 12M6.6 6.6a2 2 0 0 0 2.8 2.8M4.2 4.7C2.6 5.9 1.5 8 1.5 8S4 12.5 8 12.5c1.4 0 2.6-.5 3.6-1.2M7 3.6c.3 0 .7-.1 1-.1 4 0 6.5 4.5 6.5 4.5s-.5 1-1.5 2.1',
  bone: 'M5 11l6-6M3.8 9.8a1.6 1.6 0 1 0 2.4 2.4M12.2 6.2a1.6 1.6 0 1 0-2.4-2.4',
  part: 'M3 3.5h10v9H3zM3 9.5l3-3 3 3 2-2 2 2',
  warp: 'M2.5 3.5c3 1 8 1 11 0M2.5 8c3 1 8 1 11 0M2.5 12.5c3 1 8 1 11 0M4 2.5c-1 3.5-1 7.5 0 11M8 2.5c-1 3.5-1 7.5 0 11M12 2.5c-1 3.5-1 7.5 0 11',
  param: 'M2 4.5h12M2 11.5h12M5.5 3v3M10.5 10v3',
  film: 'M2.5 3h11v10h-11zM5 3v10M11 3v10M2.5 6.5H5M2.5 9.5H5M11 6.5h2.5M11 9.5h2.5',
  link: 'M6.5 9.5l3-3M5 7.5L3.8 8.7a2.5 2.5 0 0 0 3.5 3.5L8.5 11M11 8.5l1.2-1.2a2.5 2.5 0 0 0-3.5-3.5L7.5 5',
  search: 'M7 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM14 14l-3.5-3.5',
  fit: 'M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10',
  grid: 'M2.5 2.5h11v11h-11zM2.5 6.2h11M2.5 9.8h11M6.2 2.5v11M9.8 2.5v11',
  mesh: 'M2.5 13.5l5.5-11 5.5 11zM5.2 8h5.6M8 2.5v11M5.2 8L8 13.5 10.8 8',
  bounds: 'M4.5 2.5h7M4.5 13.5h7M2.5 4.5v7M13.5 4.5v7',
  label: 'M2.5 4.5h7l4 3.5-4 3.5h-7z',
  help: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM6.2 6.2a1.9 1.9 0 1 1 2.6 1.8c-.5.2-.8.6-.8 1.1v.4M8 11.6v.1',
  bolt: 'M9 1.5L3.5 9H8l-1 5.5L12.5 7H8z',
  undo: 'M5.5 3L2.5 6l3 3M2.5 6H10a3.5 3.5 0 0 1 0 7H7',
  redo: 'M10.5 3l3 3-3 3M13.5 6H6a3.5 3.5 0 0 0 0 7h3',
  save: 'M3 2.5h8l2.5 2.5v8.5h-11zM5 2.5v3.5h5V2.5M5 13.5V9.5h6v4',
  physics: 'M8 2v5M8 7c0 3 3 3 3 6M8 7c0 3-3 3-3 6',
  layers: 'M8 2.5l6 3-6 3-6-3zM2 8.5l6 3 6-3M2 11.5l6 3 6-3',
  reset: 'M3 8a5 5 0 1 0 1.5-3.5M3 2.5V5h2.5',
  close: 'M4 4l8 8M12 4l-8 8',
  chevronRight: 'M6 4l4 4-4 4',
  chevronDown: 'M4 6l4 4 4-4',
  chevronUp: 'M4 10l4-4 4 4',
  warning: 'M8 2l6.5 11.5h-13zM8 6.5v3M8 11.5v.1',
  error: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM5.8 5.8l4.4 4.4M10.2 5.8l-4.4 4.4',
  info: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 7.5v4M8 4.9v.1',
  check: 'M3 8.5l3 3 7-7',
  constraint: 'M3 13l4-5 3 2 3-7M13 3l-2.5.5M13 3l.3 2.5',
  texture: 'M2.5 2.5h11v11h-11zM2.5 10.5l3-3 2.5 2.5 2-2 3.5 3.5M10.5 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  model: 'M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7zM8 8l5.5-3.5M8 8v6.5M8 8L2.5 4.5',
  sidebarLeft: 'M2.5 3h11v10h-11zM6.5 3v10M3.8 5.5h1.4M3.8 7.5h1.4',
  sidebarRight: 'M2.5 3h11v10h-11zM9.5 3v10M10.8 5.5h1.4M10.8 7.5h1.4',
  pin: 'M9 2l5 5M10.5 3.5l-3 3-3 .5 4.5 4.5.5-3 3-3M6.7 9.3l-4.2 4.2',
  file: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3',
  fileNew: 'M11.5 9V4.5l-3-3H4v13h4.5M8.5 1.5v3h3M12 10.5v4M10 12.5h4',
  fileClose: 'M4 1.5h5l3 3v10H4zM9 1.5v3h3M6.4 8.4l3.2 3.2M9.6 8.4l-3.2 3.2',
  folder: 'M1.5 3.5a1 1 0 0 1 1-1h3.3l1.5 1.8h6.2a1 1 0 0 1 1 1v6.9a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z',
  folderOpen: 'M1.5 12.5v-9a1 1 0 0 1 1-1h3.3l1.5 1.8h5.2a1 1 0 0 1 1 1v1.5M1.5 12.5l1.8-5.3a1 1 0 0 1 1-.7h10.2l-2 6z',
  download: 'M8 2v8.5M4.5 7l3.5 3.5L11.5 7M2.5 13.5h11',
  upload: 'M8 10.5V2M4.5 5.5L8 2l3.5 3.5M2.5 13.5h11',
  clock: 'M8 14.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM8 4.5V8l2.5 1.5',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5',
  arrowUp: 'M8 13V3M4 7l4-4 4 4',
  home: 'M2.5 7.5L8 2.5l5.5 5M4 6.5v7h8v-7',
  plus: 'M8 3v10M3 8h10',
  camera: 'M2 5h2.8l1-1.5h4.4l1 1.5H14v8H2zM8 11.3a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z',
  saveAs: 'M8.5 13.5h-6v-11h8L13 5v2.5M5 2.5v3.5h5V2.5M5 13.5V9.5h3M10 14.5l.4-1.9 3-3 1.5 1.5-3 3z',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  sparkle: 'M8 1.5l1.4 4.1L13.5 7l-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4zM13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z',
} as const;

export type IconName = keyof typeof PATHS;

const FILLED = new Set<IconName>(['play', 'toStart', 'stepBack', 'stepFwd', 'bolt']);

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  const filled = FILLED.has(name);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={filled ? 1 : 1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="icon"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
