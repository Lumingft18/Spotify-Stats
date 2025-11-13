import type { TabName } from '../types';

interface SidebarProps {
  currentTab: TabName;
  onTabChange: (tab: TabName) => void;
  showAdvanced: boolean;
  onToggleAdvanced: () => void;
}

const MAIN_TABS: { id: TabName; label: string; icon: string }[] = [
  { id: 'basics', label: 'Dashboard', icon: '📊' },
  { id: 'most played artists', label: 'Top Artisti', icon: '👤' },
  { id: 'most played songs', label: 'Top Canzoni', icon: '🎵' },
  { id: 'most played albums', label: 'Top Album', icon: '💿' },
  { id: 'most played per month', label: 'Per Mese', icon: '📅' },
  { id: 'play time per day', label: 'Tempo per Giorno', icon: '⏰' },
];

const ADVANCED_TABS: { id: TabName; label: string; icon: string }[] = [
  { id: 'mood', label: 'Mood', icon: '😊' },
  { id: 'general', label: 'Generale', icon: '📈' },
  { id: 'songs of top artists', label: 'Canzoni Top Artisti', icon: '🎤' },
  { id: 'most played songs clicked on', label: 'Canzoni Cliccate', icon: '👆' },
  { id: 'countries', label: 'Paesi', icon: '🌍' },
  { id: 'average song length', label: 'Lunghezza Media', icon: '⏱️' },
  { id: 'song stats', label: 'Statistiche Canzoni', icon: '📊' },
  { id: 'unique and new played songs', label: 'Canzoni Uniche', icon: '🆕' },
  { id: 'cumulative play count', label: 'Conteggio Cumulativo', icon: '📉' },
  { id: 'skipped analysis', label: 'Analisi Skip', icon: '⏭️' },
];

export function Sidebar({ currentTab, onTabChange, showAdvanced, onToggleAdvanced }: SidebarProps) {
  return (
    <aside className="w-64 bg-gray-900 border-r border-gray-800 h-screen sticky top-0 overflow-y-auto">
      <div className="p-6">
        <h2 className="text-xl font-bold text-white mb-6 flex items-center gap-2">
          <span className="text-2xl">🎵</span>
          <span className="bg-gradient-to-r from-green-400 to-green-600 bg-clip-text text-transparent">
            Statistiche
          </span>
        </h2>

        <nav className="space-y-2">
          <div className="mb-4">
            <div className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 px-3">
              Principali
            </div>
            {MAIN_TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => onTabChange(tab.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${
                  currentTab === tab.id
                    ? 'bg-gradient-to-r from-green-600 to-green-700 text-white shadow-lg'
                    : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                }`}
              >
                <span className="text-lg">{tab.icon}</span>
                <span className="font-medium">{tab.label}</span>
              </button>
            ))}
          </div>

          <div className="border-t border-gray-800 pt-4 mt-4">
            <button
              onClick={onToggleAdvanced}
              className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg transition-all duration-200 mb-2 ${
                showAdvanced
                  ? 'bg-gray-800 text-white'
                  : 'text-gray-400 hover:bg-gray-800 hover:text-white'
              }`}
            >
              <div className="flex items-center gap-2">
                <span>⚙️</span>
                <span className="font-medium">Avanzate</span>
              </div>
              <span className={`transition-transform duration-200 ${showAdvanced ? 'rotate-90' : ''}`}>
                ▶
              </span>
            </button>

            {showAdvanced && (
              <div className="space-y-1">
                {ADVANCED_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => onTabChange(tab.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg transition-all duration-200 ${
                      currentTab === tab.id
                        ? 'bg-gradient-to-r from-green-600 to-green-700 text-white shadow-lg'
                        : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                    }`}
                  >
                    <span className="text-lg">{tab.icon}</span>
                    <span className="font-medium text-sm">{tab.label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </nav>
      </div>
    </aside>
  );
}

