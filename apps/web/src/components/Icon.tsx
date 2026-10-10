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
  | 'chat'
  | 'pip';

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
  chat: <path d="M3 4h18v13H10l-5 4v-4H3z" />,
  pip: (
    <>
      <rect x="3" y="4" width="18" height="16" />
      <rect x="12" y="12" width="7" height="6" />
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
