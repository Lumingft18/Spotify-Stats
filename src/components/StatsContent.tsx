import type { DataCache, BasicStats, TabName } from '../types';
import { DataTable } from './DataTable';
import { Plot } from './Plot';
import { MultiLinePlot } from './MultiLinePlot';
import { formatText } from '../utils/dataProcessing';
import { Dashboard } from './Dashboard';
import { MoodContent } from './MoodContent';

interface StatsContentProps {
  tab: TabName;
  dataCache: DataCache;
  isUserData: boolean;
}

export function StatsContent({ tab, dataCache, isUserData }: StatsContentProps) {
  const basicsDict = dataCache['basics_dict'] as BasicStats;

  const renderContent = () => {
    switch (tab) {
      case 'basics': {
        return <Dashboard stats={basicsDict} />;
      }

      case 'most played artists':
        return (
          <DataTable
            title="Artisti più riprodotti"
            data={dataCache['most_played_artists_total'] as any}
            showRank={true}
          />
        );

      case 'most played songs':
        return (
          <DataTable
            title="Canzoni più riprodotte"
            data={dataCache['most_played_tracks_total'] as any}
            showRank={true}
          />
        );

      case 'most played albums':
        return (
          <DataTable
            title="Album più riprodotti"
            data={dataCache['most_played_albums_total'] as any}
            showRank={true}
          />
        );

      case 'most played per month':
        return (
          <DataTable
            title="Artista, canzone e album più riprodotti per mese"
            data={dataCache['most_played_artists_track_album_monthly'] as any}
          />
        );

      case 'play time per day': {
        const yearMonthData = dataCache['avg_hours_played_per_year_month'] as any;
        const yearData = dataCache['avg_hours_played_per_year'] as any;
        const monthData = dataCache['avg_hours_played_per_month'] as any;
        const dayNameData = dataCache['avg_hours_played_per_day_name'] as any;
        const hourData = dataCache['hours_played_percent_per_hour_of_the_day'] as any;

        return (
          <div className="space-y-8">
            {yearMonthData && (
              <Plot
                title="Media ore riprodotte per giorno per anno e mese"
                data={yearMonthData}
                yHour={true}
                yAxisYear={true}
              />
            )}
            {yearData && (
              <Plot
                title="Media ore riprodotte per giorno per anno"
                data={yearData}
                yHour={true}
              />
            )}
            {monthData && (
              <Plot
                title="Media ore riprodotte per giorno per mese"
                data={monthData}
                yHour={true}
              />
            )}
            {dayNameData && (
              <Plot
                title="Media ore riprodotte per giorno per giorno della settimana"
                data={dayNameData}
                yHour={true}
              />
            )}
            {hourData && (
              <Plot
                title="Percentuale di tempo di riproduzione per ora del giorno"
                data={hourData}
                percent={true}
              />
            )}
          </div>
        );
      }

      case 'general': {
        const advancedBasicText = `
          <div class="space-y-6">
            <div class="bg-gradient-to-br from-gray-800 to-gray-900 rounded-xl p-6 border border-gray-700">
              <h4 class="text-lg font-semibold text-green-400 mb-4">📅 Periodo di ascolto</h4>
              <p class="text-gray-300">I tuoi record iniziano il <span class="font-bold text-white">{first_day}</span> e terminano il <span class="font-bold text-white">{last_day}</span>. Sono <span class="font-bold text-green-500">{number_of_days}</span> giorni.</p>
              <p class="text-gray-300 mt-2">Hai riprodotto canzoni per <span class="font-bold text-green-500">{number_of_days_with_tracks_played}</span> giorni, che rappresentano il <span class="font-bold text-green-500">{percent_of_days_with_tracks_played}%</span> di tutti i giorni.</p>
            </div>
            
            <div class="bg-gradient-to-br from-gray-800 to-gray-900 rounded-xl p-6 border border-gray-700">
              <h4 class="text-lg font-semibold text-green-400 mb-4">🎵 Riproduzioni</h4>
              <p class="text-gray-300">Hai riprodotto <span class="font-bold text-green-500">{played_songs}</span> canzoni, per un totale di <span class="font-bold text-green-500">{listening_hours}</span> ore. In media circa <span class="font-bold text-white">{played_songs_per_day}</span> tracce o <span class="font-bold text-white">{listening_hours_per_day}</span> ore al giorno.</p>
              <p class="text-gray-300 mt-2">Hai ascoltato <span class="font-bold text-green-500">{unique_tracks_played}</span> canzoni uniche, da <span class="font-bold text-green-500">{unique_artists_played}</span> artisti e <span class="font-bold text-green-500">{unique_albums_played}</span> album. In media circa <span class="font-bold text-white">{unique_tracks_played_per_artist}</span> canzoni per artista.</p>
              <p class="text-gray-300 mt-2">Riproduci una canzone, in media, <span class="font-bold text-green-500">{average_play_count_per_song}</span> volte.</p>
            </div>
            
            <div class="bg-gradient-to-br from-gray-800 to-gray-900 rounded-xl p-6 border border-gray-700">
              <h4 class="text-lg font-semibold text-green-400 mb-4">🔀 Shuffle e Skip</h4>
              <p class="text-gray-300">Circa il <span class="font-bold text-green-500">{percent_of_played_songs_using_shuffle}%</span> di tutte le canzoni che hai ascoltato sono state riprodotte usando shuffle.</p>
              <p class="text-gray-300 mt-2">Hai saltato <span class="font-bold text-green-500">{skipped_songs}</span> canzoni, che rappresentano circa il <span class="font-bold text-green-500">{percent_of_skipped_songs}%</span> di tutte le canzoni che hai iniziato.</p>
              <p class="text-gray-300 mt-2">In media, ascolti una canzone per <span class="font-bold text-white">{avg_seconds_played_before_skipping}</span> secondi prima di saltarla. Delle canzoni che salti, il <span class="font-bold text-green-500">{percent_of_songs_skipped_before_3s}%</span> viene saltato entro 3 secondi, mentre il <span class="font-bold text-green-500">{percent_of_songs_skipped_after_30s}%</span> viene saltato dopo più di 30 secondi e il <span class="font-bold text-green-500">{percent_of_songs_skipped_after_120s}%</span> dopo più di 2 minuti.</p>
              <p class="text-gray-300 mt-2">Salto il <span class="font-bold text-green-500">{percent_of_skipped_songs_using_shuffle}%</span> di tutte le canzoni iniziate quando uso shuffle e il <span class="font-bold text-green-500">{percent_of_skipped_songs_not_using_shuffle}%</span> quando non uso shuffle.</p>
            </div>
            
            <div class="bg-gradient-to-br from-gray-800 to-gray-900 rounded-xl p-6 border border-gray-700">
              <h4 class="text-lg font-semibold text-green-400 mb-4">🎮 Modalità di riproduzione</h4>
              <p class="text-gray-300">Ho iniziato il <span class="font-bold text-green-500">{percent_reason_start_forward_button}%</span> delle mie canzoni perché ho cliccato il pulsante avanti, il <span class="font-bold text-green-500">{percent_reason_start_back_button}%</span> perché ho cliccato il pulsante indietro, il <span class="font-bold text-green-500">{percent_reason_start_trackdone}%</span> perché la canzone precedente è finita e il <span class="font-bold text-green-500">{percent_reason_start_clickrow}%</span> perché ho cliccato sulla canzone.</p>
              <p class="text-gray-300 mt-2">Ho riprodotto il <span class="font-bold text-green-500">{percent_of_played_songs_using_incognito_mode}%</span> delle mie canzoni usando la modalità incognito.</p>
            </div>
          </div>
        `;
        const formattedText = formatText(advancedBasicText, basicsDict, isUserData);
        return (
          <div
            className="text-left"
            dangerouslySetInnerHTML={{ __html: formattedText }}
          />
        );
      }

      case 'songs of top artists':
        return (
          <DataTable
            title="Top canzoni dei top artisti"
            data={dataCache['top_songs_of_top_artists'] as any}
          />
        );

      case 'most played songs clicked on':
        return (
          <DataTable
            title="Canzoni più riprodotte che sono iniziate perché sono state cliccate"
            data={dataCache['most_played_tracks_total_reason_start_clickrow'] as any}
            showRank={true}
          />
        );

      case 'countries':
        return (
          <DataTable
            title="Riproduzioni per paese in totale"
            data={dataCache['plays_per_county_total'] as any}
          />
        );

      case 'average song length':
        return (
          <Plot
            title="Lunghezza media della canzone per mese"
            data={dataCache['avg_track_length_monthly'] as any}
            yMinute={true}
          />
        );

      case 'song stats': {
        const playCountData = dataCache['avg_play_count_per_song_yearly'] as any;
        const distributionData = dataCache['play_count_distribution'] as any;

        return (
          <div className="space-y-8">
            {playCountData && (
              <Plot
                title="Media conteggio riproduzioni per canzone ogni anno"
                data={playCountData}
                yAxisYear={true}
              />
            )}
            {distributionData && (
              <Plot
                title="Distribuzione di quante canzoni sono riprodotte quante volte"
                data={distributionData}
              />
            )}
          </div>
        );
      }

      case 'unique and new played songs': {
        const yearlyData = dataCache['yearly_track_play_count'] as any;
        return (
          <MultiLinePlot
            title="Conteggio riproduzioni canzoni annuali"
            data={yearlyData}
            yUnit="canzoni riprodotte"
            barChart={true}
          />
        );
      }

      case 'cumulative play count': {
        const topArtistsText = `
          <div class="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
            <div class="bg-gradient-to-br from-gray-800 to-gray-900 rounded-xl p-6 border border-gray-700">
              <h4 class="text-lg font-semibold text-green-400 mb-4">👤 Artisti</h4>
              <ul class="space-y-3 text-gray-300">
                <li>Top 10 artisti: <span class="font-bold text-green-500">{top_10_artist_play_count_percent}%</span></li>
                <li>Top 100 artisti: <span class="font-bold text-green-500">{top_100_artist_play_count_percent}%</span></li>
                <li>Top 500 artisti: <span class="font-bold text-green-500">{top_500_artist_play_count_percent}%</span></li>
              </ul>
            </div>
            <div class="bg-gradient-to-br from-gray-800 to-gray-900 rounded-xl p-6 border border-gray-700">
              <h4 class="text-lg font-semibold text-green-400 mb-4">🎵 Canzoni</h4>
              <ul class="space-y-3 text-gray-300">
                <li>Top 10 canzoni: <span class="font-bold text-green-500">{top_10_track_play_count_percent}%</span></li>
                <li>Top 100 canzoni: <span class="font-bold text-green-500">{top_100_track_play_count_percent}%</span></li>
                <li>Top 500 canzoni: <span class="font-bold text-green-500">{top_500_track_play_count_percent}%</span></li>
              </ul>
            </div>
          </div>
        `;
        const formattedText = formatText(topArtistsText, basicsDict, isUserData);
        const artistData = dataCache['cumulative_percent_play_count_artist'] as any;
        const trackData = dataCache['cumulative_percent_play_count_track'] as any;

        return (
          <div className="space-y-8">
            <div
              className="text-left"
              dangerouslySetInnerHTML={{ __html: formattedText }}
            />
            {artistData && (
              <Plot
                title="Conteggio riproduzioni cumulativo per numero di artisti in percentuale di tutte le canzoni riprodotte"
                data={artistData}
                type="scatter"
                percent={true}
              />
            )}
            {trackData && (
              <Plot
                title="Conteggio riproduzioni cumulativo per numero di canzoni in percentuale di tutte le canzoni riprodotte"
                data={trackData}
                type="scatter"
                percent={true}
              />
            )}
          </div>
        );
      }

      case 'mood':
        return <MoodContent dataCache={dataCache} />;

      case 'skipped analysis': {
        const skippedOverview = dataCache['skipped_overview'] as any;
        const mostSkippedArtists = dataCache['most_skipped_artists'] as any;
        const mostSkippedTracks = dataCache['most_skipped_tracks'] as any;
        const artistSkipRates = dataCache['artist_skip_rates'] as any;
        const monthlySkipRate = dataCache['monthly_skip_rate'] as any;

        return (
          <div className="space-y-8">
            {skippedOverview && (
              <Plot
                title="Panoramica Brani Saltati"
                data={skippedOverview}
                percent={true}
              />
            )}
            {mostSkippedArtists && (
              <DataTable
                title="Artisti Più Saltati"
                data={mostSkippedArtists}
                showRank={true}
              />
            )}
            {mostSkippedTracks && (
              <DataTable
                title="Canzoni Più Saltate"
                data={mostSkippedTracks}
                showRank={true}
              />
            )}
            {artistSkipRates && (
              <DataTable
                title="Tasso di Skip per Artista (Top 30)"
                data={artistSkipRates}
                showRank={true}
              />
            )}
            {monthlySkipRate && (
              <Plot
                title="Tasso di Skip per Mese"
                data={monthlySkipRate}
                percent={true}
                yAxisYear={true}
              />
            )}
          </div>
        );
      }

      default:
        return <div>Contenuto non disponibile</div>;
    }
  };

  return <div className="w-full">{renderContent()}</div>;
}

