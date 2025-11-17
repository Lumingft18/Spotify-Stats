import type { BasicStats } from '../types';
import { formatNumber } from '../utils/dataProcessing';

interface DashboardProps {
  stats: BasicStats;
}

export function Dashboard({ stats }: DashboardProps) {
  const cards = [
    {
      title: 'Tempo totale di ascolto',
      value: `${Math.floor(stats.listening_hours)}h`,
      subtitle: `${stats.listening_hours_per_day}h al giorno`,
      icon: '🎵',
      color: 'from-green-500 to-emerald-600',
    },
    {
      title: 'Canzoni riprodotte',
      value: formatNumber(stats.played_songs),
      subtitle: `${formatNumber(stats.played_songs_per_day)} al giorno`,
      icon: '🎶',
      color: 'from-blue-500 to-cyan-600',
    },
    {
      title: 'Artisti unici',
      value: formatNumber(stats.unique_artists_played),
      subtitle: `${formatNumber(stats.unique_tracks_played_per_artist)} canzoni per artista`,
      icon: '👤',
      color: 'from-purple-500 to-pink-600',
    },
    {
      title: 'Album unici',
      value: formatNumber(stats.unique_albums_played),
      subtitle: `${formatNumber(stats.unique_tracks_played)} canzoni uniche`,
      icon: '💿',
      color: 'from-orange-500 to-red-600',
    },
    {
      title: 'Giorni di ascolto',
      value: formatNumber(stats.number_of_days_with_tracks_played),
      subtitle: `${stats.percent_of_days_with_tracks_played}% dei giorni`,
      icon: '📅',
      color: 'from-indigo-500 to-blue-600',
    },
    {
      title: 'Media riproduzioni',
      value: formatNumber(stats.average_play_count_per_song),
      subtitle: 'per canzone',
      icon: '🔄',
      color: 'from-teal-500 to-green-600',
    },
  ];

  const topArtists = [
    { rank: 1, name: stats.top_1_artist },
    { rank: 2, name: stats.top_2_artist },
    { rank: 3, name: stats.top_3_artist },
  ];

  const topTracks = [
    { rank: 1, name: stats.top_1_track },
    { rank: 2, name: stats.top_2_track },
    { rank: 3, name: stats.top_3_track },
  ];

  return (
    <div className="space-y-8">
      {/* Stat Cards Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {cards.map((card, idx) => (
          <div
            key={idx}
            className="relative overflow-hidden rounded-2xl bg-gradient-to-br p-6 shadow-xl transition-all duration-300 hover:scale-105 hover:shadow-2xl"
            style={{
              background: `linear-gradient(135deg, var(--tw-gradient-stops))`,
            }}
          >
            <div className={`bg-gradient-to-br ${card.color} absolute inset-0 opacity-90`} />
            <div className="relative z-10">
              <div className="flex items-start justify-between mb-4">
                <div className="text-4xl">{card.icon}</div>
                <div className="text-right">
                  <div className="text-3xl font-bold text-white mb-1">{card.value}</div>
                  <div className="text-sm text-white/80">{card.title}</div>
                </div>
              </div>
              <div className="text-sm text-white/70 mt-2">{card.subtitle}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Top Artists & Tracks */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Top Artists */}
        <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-6 border border-gray-700 shadow-xl">
          <h3 className="text-xl font-bold mb-4 text-green-400 flex items-center gap-2">
            <span>🏆</span> Top 3 Artisti
          </h3>
          <div className="space-y-3">
            {topArtists.map((artist) => (
              <div
                key={artist.rank}
                className="flex items-center gap-4 p-3 rounded-lg bg-gray-800/50 hover:bg-gray-700/50 transition-colors"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-green-500 to-emerald-600 flex items-center justify-center font-bold text-white">
                  {artist.rank}
                </div>
                <div className="flex-1 text-gray-200 font-medium truncate">{artist.name}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Top Tracks */}
        <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-6 border border-gray-700 shadow-xl">
          <h3 className="text-xl font-bold mb-4 text-green-400 flex items-center gap-2">
            <span>🎵</span> Top 3 Canzoni
          </h3>
          <div className="space-y-3">
            {topTracks.map((track) => (
              <div
                key={track.rank}
                className="flex items-center gap-4 p-3 rounded-lg bg-gray-800/50 hover:bg-gray-700/50 transition-colors"
              >
                <div className="flex-shrink-0 w-10 h-10 rounded-full bg-gradient-to-br from-blue-500 to-cyan-600 flex items-center justify-center font-bold text-white">
                  {track.rank}
                </div>
                <div className="flex-1 text-gray-200 font-medium truncate">{track.name}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Additional Stats */}
      <div className="bg-gradient-to-br from-gray-800 to-gray-900 rounded-2xl p-6 border border-gray-700 shadow-xl">
        <h3 className="text-xl font-bold mb-4 text-green-400">📊 Statistiche aggiuntive</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="flex items-center justify-between p-3 rounded-lg bg-gray-800/50">
            <span className="text-gray-300">Canzoni saltate</span>
            <span className="font-semibold text-white">
              {stats.percent_of_skipped_songs}%
            </span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-gray-800/50">
            <span className="text-gray-300">Uso shuffle</span>
            <span className="font-semibold text-white">
              {stats.percent_of_played_songs_using_shuffle}%
            </span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-gray-800/50">
            <span className="text-gray-300">Periodo di ascolto</span>
            <span className="font-semibold text-white text-sm">
              {stats.number_of_days} giorni
            </span>
          </div>
          <div className="flex items-center justify-between p-3 rounded-lg bg-gray-800/50">
            <span className="text-gray-300">Dal</span>
            <span className="font-semibold text-white text-sm">
              {new Date(stats.first_day).toLocaleDateString('it-IT')}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}





