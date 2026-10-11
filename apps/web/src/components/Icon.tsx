import type { ReactNode } from 'react';

export type IconName =
  | 'mic'
  | 'mic-off'
  | 'headphones'
  | 'headphones-off'
  | 'settings'
  | 'hang-up'
  | 'screen'
  | 'camera'
  | 'camera-off'
  | 'image'
  | 'smile'
  | 'invite'
  | 'plus'
  | 'chevron-down'
  | 'chevron-up'
  | 'eye'
  | 'chat'
  | 'pip'
  | 'volume'
  | 'volume-off'
  | 'lock'
  | 'stats'
  | 'focus'
  | 'grid'
  | 'fullscreen'
  | 'fullscreen-exit'
  | 'close'
  | 'noise'
  | 'noise-off';

const slash = <path d="M3 3l18 18" />;

const paths: Record<IconName, ReactNode> = {
  mic: (
    <>
      <rect x="9" y="3" width="6" height="11" />
      <path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8" />
    </>
  ),
  'mic-off': (
    <>
      <rect x="9" y="3" width="6" height="11" />
      <path d="M5 11v1a7 7 0 0 0 14 0v-1M12 19v3M8 22h8" />
      {slash}
    </>
  ),
  headphones: (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="14" width="4" height="7" />
      <rect x="17" y="14" width="4" height="7" />
    </>
  ),
  'headphones-off': (
    <>
      <path d="M4 14v-2a8 8 0 0 1 16 0v2" />
      <rect x="3" y="14" width="4" height="7" />
      <rect x="17" y="14" width="4" height="7" />
      {slash}
    </>
  ),
  settings: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <rect x="14" y="5" width="4" height="4" />
      <rect x="6" y="15" width="4" height="4" />
    </>
  ),
  volume: <path d="M4 9h4l5-4v14l-5-4H4zM16.5 9a4.5 4.5 0 010 6M19 6.5a8 8 0 010 11" />,
  'volume-off': (
    <>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      {slash}
    </>
  ),
  'hang-up': <path d="M2 15v-3c0-2 4-5 10-5s10 3 10 5v3l-5 1-1-4H8l-1 4z" />,
  screen: (
    <>
      <rect x="3" y="4" width="18" height="12" />
      <path d="M8 21h8M12 16v5M12 13V8M9.5 10.5L12 8l2.5 2.5" />
    </>
  ),
  camera: (
    <>
      <rect x="2" y="6" width="13" height="12" />
      <path d="M15 10l7-3v10l-7-3" />
    </>
  ),
  'camera-off': (
    <>
      <rect x="2" y="6" width="13" height="12" />
      <path d="M15 10l7-3v10l-7-3" />
      {slash}
    </>
  ),
  image: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <rect x="7" y="8" width="3" height="3" />
      <path d="M3 17l5-4 4 3 4-5 5 5" />
    </>
  ),
  smile: (
    <>
      <rect x="3" y="3" width="18" height="18" />
      <path d="M8 9v1M16 9v1M8 14c1 2 2.5 3 4 3s3-1 4-3" />
    </>
  ),
  invite: (
    <>
      <rect x="6" y="4" width="6" height="6" />
      <path d="M3 20v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3M19 7v6M16 10h6" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  'chevron-down': <path d="M6 9l6 6 6-6" />,
  'chevron-up': <path d="M6 15l6-6 6 6" />,
  eye: (
    <>
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z" />
      <circle cx="12" cy="12" r="2.5" />
    </>
  ),
  chat: <path d="M3 4h18v13H10l-5 4v-4H3z" />,
  lock: (
    <>
      <rect x="5" y="11" width="14" height="10" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  pip: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <rect x="12" y="12" width="7" height="6" />
    </>
  ),
  stats: <path d="M4 20h16M7 20v-6M12 20V5M17 20v-9" />,
  focus: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <rect x="7" y="8" width="10" height="8" />
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="8" height="8" />
      <rect x="13" y="3" width="8" height="8" />
      <rect x="3" y="13" width="8" height="8" />
      <rect x="13" y="13" width="8" height="8" />
    </>
  ),
  fullscreen: <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />,
  'fullscreen-exit': <path d="M4 9h5V4M15 4v5h5M20 15h-5v5M9 20v-5H4" />,
  close: <path d="M5 5l14 14M19 5L5 19" />,
  noise: <path d="M3 12h2M7 8v8M11 4v16M15 9v6M19 11v2" />,
  'noise-off': (
    <>
      <path d="M3 12h2M7 8v8M11 4v16M15 9v6M19 11v2" />
      {slash}
    </>
  ),
};

/** Square-cut line icons. Decorative: the button around them carries the label. */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="square"
      strokeLinejoin="miter"
    >
      {paths[name]}
    </svg>
  );
}
