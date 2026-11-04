import { create } from 'zustand';

export type ConnectionId = 'covers' | 'audiofeatures' | 'lyrics' | 'lastfm' | 'llm' | 'embedModel';

export interface Settings {
  timeZone: string;
  openrouterKey: string;
  lastfmKey: string;
  llmModelBulk: string;
  llmModelAgent: string;
  connections: Record<ConnectionId, boolean>;
}

const SETTINGS_KEY = 'ss2.settings';

const defaultSettings: Settings = {
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome',
  openrouterKey: '',
  lastfmKey: '',
  llmModelBulk: 'anthropic/claude-haiku-5.5',
  llmModelAgent: 'anthropic/claude-sonnet-5.5',
  connections: {
    covers: true,
    audiofeatures: true,
    lyrics: false,
    lastfm: false,
    llm: false,
    embedModel: true,
  },
};

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    const s = JSON.parse(raw) as Partial<Settings>;
    return { ...defaultSettings, ...s, connections: { ...defaultSettings.connections, ...(s.connections ?? {}) } };
  } catch {
    return defaultSettings;
  }
}

export interface NetEvent {
  host: string;
  at: number;
  purpose: string;
}

export interface Job {
  id: string;
  label: string;
  done: number;
  total: number;
  status: 'running' | 'paused' | 'done' | 'error';
  detail?: string;
}

interface AppState {
  status: 'booting' | 'empty' | 'importing' | 'ready';
  importStep: string;
  range: { from: string | null; to: string | null };
  bounds: { min: string; max: string } | null;
  /** Bumped whenever derived tables or the filter change → all queries re-run. */
  epoch: number;
  settings: Settings;
  jobs: Record<string, Job>;
  net: NetEvent[];
  paletteOpen: boolean;
  activityOpen: boolean;
  set: (p: Partial<AppState>) => void;
  bump: () => void;
  updateSettings: (p: Partial<Settings>) => void;
  setJob: (j: Job) => void;
  logNet: (host: string, purpose: string) => void;
}

export const useApp = create<AppState>((set, get) => ({
  status: 'booting',
  importStep: '',
  range: { from: null, to: null },
  bounds: null,
  epoch: 0,
  settings: loadSettings(),
  jobs: {},
  net: [],
  paletteOpen: false,
  activityOpen: false,
  set: (p) => set(p),
  bump: () => set({ epoch: get().epoch + 1 }),
  updateSettings: (p) => {
    const next = { ...get().settings, ...p };
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    } catch {
      /* storage full / private mode */
    }
    set({ settings: next });
  },
  setJob: (j) => set({ jobs: { ...get().jobs, [j.id]: j } }),
  logNet: (host, purpose) => {
    const net = get().net;
    const last = net[net.length - 1];
    if (last && last.host === host && Date.now() - last.at < 2000) return;
    set({ net: [...net.slice(-199), { host, at: Date.now(), purpose }] });
  },
}));

export const getApp = () => useApp.getState();
