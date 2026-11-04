// Dictionary groups. A key's namespace is its first segment (`infra.site.add` -> `infra`). Every namespace listed
// here leaves the core dictionary: its group is a separate chunk per language (built by `i18nSplit` in
// vite.config.ts), loaded with the routes that declare it in routes.tsx, else on the first key asked from it.
// A namespace not listed stays in the core, which main.tsx waits for before the first render: list here only
// namespaces the shell (sidebar, tab bar, palette, dialogs) and the dashboard do not show.
export const GROUPS = {
  settings: [
    'mcp', 'system', 'stats', 'keys', 'memory', 'trash', 'features', 'security', 'profile', 'fonts', 'accent',
    'density', 'tint', 'colors', 'themegen', 'backup', 'import', 'telegram', 'packs', 'pc', 'license', 'register', 'cdef', 'nset',
    'codex', 'update', 'vset',
  ],
  // Settings -> Companions and the words of the companion notifications (`companions.kind.*`, see
  // features/notifications/text.ts): loaded with Settings, and before a companion notice is shown
  companions: ['companions'],
  auth: ['onb', 'setup', 'login', 'pw', 'twofa'],
  infra: ['infra'],
  git: ['git'],
  team: ['team'],
  tasks: ['tasks', 'crons'],
  files: ['files', 'viewer'],
  // the media player: on the first player shown (a conversation shows one only for an audio file or in the viewer)
  media: ['media'],
  // the project / topic cards of a session header: loaded on the first hover
  where: ['where'],
  // the notifications centre (opened from the sidebar) and the /notifications page; the badges, the To handle card
  // and the notices use feed.* (core)
  ncentre: ['ncentre'],
  show: ['show'],
  feedback: ['feedback'],
  // Maxxing mode (beta, off by default): its texts load only once its controls show
  maxxing: ['maxxing'],
  // dragging content from one session into another: loaded when a drag starts
  drag: ['drag'],
  // a pasted text that became a file: loaded on that paste
  paste: ['paste'],
  // conversation blocks (features/blocks): loaded with the first block shown, and with Settings
  blocks: ['blocks'],
  // what a conversation opens on demand: activity rows and the footer's details (convx.*), Change limits, the summary,
  // the HUD, the agent map and the side question. Loaded once the sessions page is on screen (pages/sessions)
  convx: ['convx', 'summary', 'hud', 'swarm', 'aside'],
} as const satisfies Record<string, readonly string[]>

export type Group = keyof typeof GROUPS
