import { create } from 'zustand';
import type { AccountProfile } from '../data/account';

export type ConnectionId = 'covers' | 'audiofeatures' | 'lyrics' | 'lastfm' | 'llm' | 'embedModel';

export interface Settings {
  timeZone: string;
  openrouterKey: string;
  lastfmKey: string;
  llmModelBulk: string;
  llmModelAgent: string;
  connections: Record<ConnectionId, boolean>;
  /** Start the AI mood estimate automatically after enrichment when an OpenRouter key is set. */
  autoMoodAi: boolean;
  /** Max tracks per automatic run (most-listened first). */
  autoMoodAiLimit: number;
}

const SETTINGS_KEY = 'ss2.settings';

/** Keys from .env.local (local dev server only). They win over values saved in the browser. */
export const ENV_KEYS = typeof __LOCAL_KEYS__ === 'undefined' ? {} : __LOCAL_KEYS__;

const defaultSettings: Settings = {
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Rome',
  openrouterKey: '',
  lastfmKey: '',
  llmModelBulk: 'anthropic/claude-haiku-5.5',
  llmModelAgent: 'anthropic/claude-sonnet-5.5',
  autoMoodAi: true,
  autoMoodAiLimit: 500,
  connections: {
    covers: true,
    audiofeatures: true,
    lyrics: true,
    lastfm: true,
    llm: false,
    embedModel: true,
  },
};

function withEnv(s: Settings): Settings {
  const e = ENV_KEYS;
  return {
    ...s,
    openrouterKey: e.openrouterKey || s.openrouterKey,
    lastfmKey: e.lastfmKey || s.lastfmKey,
    llmModelBulk: e.llmModelBulk || s.llmModelBulk,
    llmModelAgent: e.llmModelAgent || s.llmModelAgent,
    connections: { ...s.connections, llm: e.openrouterKey ? true : s.connections.llm },
  };
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return withEnv(defaultSettings);
    const s = JSON.parse(raw) as Partial<Settings>;
    return withEnv({ ...defaultSettings, ...s, connections: { ...defaultSettings.connections, ...(s.connections ?? {}) } });
  } catch {
    return withEnv(defaultSettings);
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
  /** Personal "account data" package (name, library, playlists…) when uploaded, or a manually entered name. */
  profile: AccountProfile | null;
  /** What kind of listening history is loaded. */
  dataset: { historyKind: 'extended' | 'legacy'; rows: number } | null;
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
  profile: null,
  dataset: null,
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
