import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { parseExport } from '../src/data/import';

const j = (o: unknown) => strToU8(JSON.stringify(o));

describe('account package', () => {
  it('reads identity, library, playlists and maps legacy history to URIs', async () => {
    const zip = zipSync({
      'MyData/Identity.json': j({ displayName: 'Mario Rossi' }),
      'MyData/Userdata.json': j({ username: 'mario99', country: 'IT', creationTime: '2015-03-02' }),
      'MyData/YourLibrary.json': j({ tracks: [{ artist: 'ABBA', album: 'Arrival', track: 'Money, Money, Money', uri: 'spotify:track:3lKN03PDeBnXZS7sDukRBt' }] }),
      'MyData/Playlist1.json': j({ playlists: [{ name: 'Estate', lastModifiedDate: '2024-07-01', items: [{ track: { trackName: 'Dancing Queen', artistName: 'ABBA', albumName: 'Arrival', trackUri: 'spotify:track:0GjEhVFGZW8afUYGChu3Rr' } }] }] }),
      'MyData/SearchQueries.json': j([{ searchQuery: 'abba', searchTime: '2024-01-01T10:00:00Z' }]),
      'MyData/Inferences.json': j({ inferences: ['1P_Custom_Pop_Lovers', '3P_Music_Disco'] }),
      'MyData/StreamingHistory_music_0.json': j([
        { endTime: '2024-07-02 10:00', artistName: 'ABBA', trackName: 'Dancing Queen', msPlayed: 200000 },
        { endTime: '2024-07-02 10:04', artistName: 'ABBA', trackName: 'Money, Money, Money', msPlayed: 180000 },
        { endTime: '2024-07-02 10:08', artistName: 'Unknown', trackName: 'Nope', msPlayed: 1000 },
      ]),
      'MyData/StreamingHistory_podcast_0.json': j([{ endTime: '2024-07-02 11:00', podcastName: 'x', episodeName: 'y', msPlayed: 1 }]),
    });
    const file = new File([zip], 'my_spotify_data.zip');
    const r = await parseExport([file], 'Europe/Rome');
    expect(r.historyKind).toBe('legacy');
    expect(r.stats.rows).toBe(3);
    expect(r.profile?.displayName).toBe('Mario Rossi');
    expect(r.profile?.username).toBe('mario99');
    expect(r.profile?.library.tracks).toBe(1);
    expect(r.profile?.playlists[0].name).toBe('Estate');
    expect(r.profile?.searches.length).toBe(1);
    expect(r.profile?.inferences).toEqual(['1P_Custom_Pop_Lovers', '3P_Music_Disco']);
    expect(r.cols.track_uri).toEqual(['spotify:track:0GjEhVFGZW8afUYGChu3Rr', 'spotify:track:3lKN03PDeBnXZS7sDukRBt', null]);
  });

  it('prefers extended history when both packages are dropped together', async () => {
    const acc = zipSync({
      'MyData/Identity.json': j({ displayName: 'Mario' }),
      'MyData/StreamingHistory_music_0.json': j([{ endTime: '2024-07-02 10:00', artistName: 'A', trackName: 'B', msPlayed: 200000 }]),
    });
    const ext = zipSync({
      'Spotify Extended Streaming History/Streaming_History_Audio_2024.json': j([
        { ts: '2024-07-02T10:00:00Z', ms_played: 200000, master_metadata_track_name: 'B', master_metadata_album_artist_name: 'A', spotify_track_uri: 'spotify:track:x', reason_end: 'trackdone' },
        { ts: '2024-07-03T10:00:00Z', ms_played: 200000, master_metadata_track_name: 'C', master_metadata_album_artist_name: 'A', spotify_track_uri: 'spotify:track:y', reason_end: 'trackdone' },
      ]),
    });
    const r = await parseExport([new File([acc], 'a.zip'), new File([ext], 'b.zip')], 'UTC');
    expect(r.historyKind).toBe('extended');
    expect(r.stats.rows).toBe(2);
    expect(r.profile?.displayName).toBe('Mario');
  });
});
