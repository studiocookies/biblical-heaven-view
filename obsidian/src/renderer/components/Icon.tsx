import type { SVGProps } from 'react';

const PATHS: Record<string, string> = {
  home: 'M3.5 10.2 12 3.5l8.5 6.7M6 8.6V20h4.5v-5.5h3V20H18V8.6',
  projects: 'M3.5 6.5h6l1.8 2h9.2v10.5h-17zM3.5 10.5h17',
  sessions: 'M4 5h16v11H4zM8 20h8M12 16v4M7.5 9l2 1.75-2 1.75M11.5 12.5h4',
  agents: 'M12 3.5a3.2 3.2 0 1 1 0 6.4 3.2 3.2 0 0 1 0-6.4zM5.5 20c.6-3.6 3.2-6 6.5-6s5.9 2.4 6.5 6M18.5 6.5l1.8-1.3M5.5 6.5 3.7 5.2M20.5 11h1.6M1.9 11h1.6',
  files: 'M7 3.5h7l4.5 4.5v12.5H7zM14 3.5V8h4.5M9.5 12.5h6M9.5 15.5h6',
  git: 'M6.5 4v10M6.5 14a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17.5 5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM17.5 10c0 4-4 4.5-11 4',
  settings: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M5.5 18.5l1.7-1.7M16.8 7.2l1.7-1.7',
  plus: 'M12 5v14M5 12h14',
  close: 'M6.5 6.5l11 11M17.5 6.5l-11 11',
  chevronRight: 'M9.5 6l6 6-6 6',
  chevronDown: 'M6 9.5l6 6 6-6',
  folder: 'M3.5 6.5h6l1.8 2h9.2v10.5h-17z',
  folderOpen: 'M3.5 19V6.5h6l1.8 2h7.2v2.5M3.5 19l2.8-8.5h15.2L18.7 19z',
  file: 'M7 3.5h7l4.5 4.5v12.5H7zM14 3.5V8h4.5',
  terminal: 'M3.5 5h17v14h-17zM7 9.5l3 2.5-3 2.5M12.5 15h4.5',
  claude: 'M12 3l1.6 5.4L19 6.5l-3.4 4.4L21 12l-5.4 1.1 3.4 4.4-5.4-1.9L12 21l-1.6-5.4L5 17.5l3.4-4.4L3 12l5.4-1.1L5 6.5l5.4 1.9z',
  refresh: 'M19.5 8.5A8 8 0 0 0 5 7.5M4.5 15.5A8 8 0 0 0 19 16.5M19.5 4v4.5H15M4.5 20v-4.5H9',
  search: 'M10.5 4a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13zM15.5 15.5 20 20',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  trash: 'M5 7h14M10 7V4.5h4V7M7 7l1 13h8l1-13',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4',
  stop: 'M7 7h10v10H7z',
  play: 'M8 5.5v13l10.5-6.5z',
  resume: 'M4 12a8 8 0 1 0 2.5-5.8M4 4v4.5h4.5M10.5 9v6l4.5-3z',
  history: 'M4 12a8 8 0 1 0 2.5-5.8M4 4v4.5h4.5M12 8v4.5l3 2',
  panelLeft: 'M3.5 4.5h17v15h-17zM9 4.5v15',
  panelRight: 'M3.5 4.5h17v15h-17zM15 4.5v15',
  panelBottom: 'M3.5 4.5h17v15h-17zM3.5 14.5h17',
  command: 'M9 6.5a2.5 2.5 0 1 0-2.5 2.5H17.5A2.5 2.5 0 1 0 15 6.5v11a2.5 2.5 0 1 0 2.5-2.5h-11A2.5 2.5 0 1 0 9 17.5z',
  copy: 'M8.5 8.5h11v11h-11zM15.5 8.5v-4h-11v11h4',
  reveal: 'M4 12s3-6.5 8-6.5S20 12 20 12s-3 6.5-8 6.5S4 12 4 12zM12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  diff: 'M7 4v8M3 8h8M13 18h8M15 4l-6 16',
  branch: 'M7 4v16M7 13c0-3 4-4 10-4M17 6.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
  activity: 'M3 12h4l3-7 4 14 3-7h4',
  info: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 11v5.5M12 7.5v.5',
  warning: 'M12 4l9 16H3zM12 10v4.5M12 17v.5',
  orbit: 'M12 9.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5zM3 12c0-2.5 4-4.5 9-4.5s9 2 9 4.5-4 4.5-9 4.5-9-2-9-4.5z',
  send: 'M4 12l16-7.5L13.5 20l-2.5-6.5z',
  interrupt: 'M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM9.5 9v6M14.5 9v6',
  keyboard: 'M3 7h18v11H3zM6.5 10.5h1M10 10.5h1M13.5 10.5h1M17 10.5h1M7 14.5h10',
  shield: 'M12 3.5l7.5 3v5.5c0 4.5-3.2 7.5-7.5 8.5-4.3-1-7.5-4-7.5-8.5V6.5z',
  stage: 'M12 5v14M5 12h14',
  unstage: 'M5 12h14',
  undo: 'M9 14L4 9l5-5M4 9h10a6 6 0 0 1 0 12h-3',
  composer: 'M4 6h16M4 10.5h16M4 15h9M16 15l4 2.5-4 2.5z',
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, ...rest }: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
