export interface DataFrameData {
  columns: string[];
  data: (string | number)[][];
}

export interface MoodAnalysisResult {
  track: string;
  artist: string;
  valence: number;
  energy?: number;
  danceability?: number;
  mood_category?: 'felice' | 'neutrale' | 'triste' | 'sconosciuto';
  confidence?: number;
}

export interface BasicStats {
  first_day: string;
  last_day: string;
  number_of_days: number;
  number_of_days_with_tracks_played: number;
  percent_of_days_with_tracks_played: number;
  played_songs: number;
  played_songs_per_day: number;
  unique_tracks_played: number;
  unique_artists_played: number;
  unique_albums_played: number;
  unique_tracks_played_per_artist: number;
  listening_hours: number;
  listening_hours_per_day: string;
  percent_of_played_songs_using_shuffle: number;
  skipped_songs: number;
  percent_of_skipped_songs: number;
  avg_seconds_played_before_skipping: number;
  percent_of_songs_skipped_before_3s: number;
  percent_of_songs_skipped_after_30s: number;
  percent_of_songs_skipped_after_120s: number;
  percent_of_skipped_songs_using_shuffle: number;
  percent_of_skipped_songs_not_using_shuffle: number;
  percent_reason_start_forward_button: number;
  percent_reason_start_back_button: number;
  percent_reason_start_trackdone: number;
  percent_reason_start_clickrow: number;
  percent_of_played_songs_using_incognito_mode: number;
  average_play_count_per_song: number;
  percent_played_songs_reason_start_clickrow: number;
  top_10_artist_play_count_percent: number;
  top_100_artist_play_count_percent: number;
  top_500_artist_play_count_percent: number;
  top_10_track_play_count_percent: number;
  top_100_track_play_count_percent: number;
  top_500_track_play_count_percent: number;
  top_1_artist: string;
  top_1_track: string;
  top_2_artist: string;
  top_2_track: string;
  top_3_artist: string;
  top_3_track: string;
}

export interface DataCache {
  [key: string]: DataFrameData | BasicStats;
}

export type TabName =
  | 'basics'
  | 'most played artists'
  | 'most played songs'
  | 'most played albums'
  | 'most played per month'
  | 'play time per day'
  | 'general'
  | 'songs of top artists'
  | 'most played songs clicked on'
  | 'countries'
  | 'average song length'
  | 'song stats'
  | 'unique and new played songs'
  | 'cumulative play count'
  | 'mood'
  | 'skipped analysis';

