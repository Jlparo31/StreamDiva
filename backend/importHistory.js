const axios = require("axios");
const pool = require("./database");


async function importHistory(accessToken, userId) {
    const response = await axios.get(
        "https://api.spotify.com/v1/me/player/recently-played",
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            params: {
                limit: 50
            }
        }
    );

    const tracks = response.data.items || [];
    return importHistoryFromItems(tracks, userId);
}


async function importHistoryFromItems(items, userId) {
    if (!Array.isArray(items)) return;

    for (const rawItem of items) {
        try {
            // Normalize item to have a `track` object and `played_at` timestamp when possible
            let item = rawItem;

            let track = item.track || null;
            let playedAt = item.played_at || item.playedAt || item.endTime || item.end_time || item.timestamp || null;

            if (!track) {
                const trackName = item.trackName || item.track_name || item.title || item.name || null;
                const artistName = item.artistName || item.artist_name || (item.artists && item.artists[0] && item.artists[0].name) || null;
                const durationMs = item.msPlayed || item.ms_played || item.duration_ms || 0;

                track = {
                    id: null,
                    name: trackName,
                    duration_ms: durationMs,
                    artists: [{ id: null, name: artistName }],
                    album: { images: [{ url: null }], name: null }
                };
            }

            let artist = track.artists?.[0] || { id: null, name: "Unknown Artist" };
            const albumImage = track.album?.images?.[0]?.url || null;
            const albumName = track.album?.name || null;

            // Normalize playedAt to ISO if possible
            let playedAtIso = null;
            if (playedAt) {
                const parsed = new Date(playedAt);
                if (!Number.isNaN(parsed.getTime())) {
                    playedAtIso = parsed.toISOString();
                } else {
                    // Try replacing space with T
                    const alt = playedAt.replace(" ", "T") + (playedAt.endsWith("Z") ? "" : "Z");
                    const parsed2 = new Date(alt);
                    if (!Number.isNaN(parsed2.getTime())) {
                        playedAtIso = parsed2.toISOString();
                    }
                }
            }

            // Insert or lookup artist
            let artistId = null;

            if (artist.id) {
                const artistResult = await pool.query(
                    `
                    INSERT INTO artists (spotify_artist_id, name, image_url)
                    VALUES ($1,$2,$3)
                    ON CONFLICT (spotify_artist_id)
                    DO UPDATE SET name = EXCLUDED.name, image_url = EXCLUDED.image_url
                    RETURNING id
                    `,
                    [artist.id, artist.name, null]
                );

                artistId = artistResult.rows[0].id;
            } else {
                const existing = await pool.query(`SELECT id FROM artists WHERE name = $1 LIMIT 1`, [artist.name]);
                if (existing.rows.length) {
                    artistId = existing.rows[0].id;
                } else {
                    const insert = await pool.query(
                        `INSERT INTO artists (spotify_artist_id, name, image_url) VALUES ($1,$2,$3) RETURNING id`,
                        [null, artist.name, null]
                    );
                    artistId = insert.rows[0].id;
                }
            }

            // Insert or lookup song
            let songId = null;

            if (track.id) {
                const songResult = await pool.query(
                    `
                    INSERT INTO songs (spotify_song_id, artist_id, name, duration_ms, album_name, album_image_url)
                    VALUES ($1,$2,$3,$4,$5,$6)
                    ON CONFLICT (spotify_song_id)
                    DO UPDATE SET name = EXCLUDED.name, duration_ms = EXCLUDED.duration_ms, album_name = EXCLUDED.album_name, album_image_url = EXCLUDED.album_image_url
                    RETURNING id
                    `,
                    [track.id, artistId, track.name, track.duration_ms || 0, albumName, albumImage]
                );

                songId = songResult.rows[0].id;
            } else {
                const existingSong = await pool.query(`SELECT id FROM songs WHERE name = $1 AND artist_id = $2 LIMIT 1`, [track.name, artistId]);
                if (existingSong.rows.length) {
                    songId = existingSong.rows[0].id;
                } else {
                    const insertSong = await pool.query(
                        `INSERT INTO songs (spotify_song_id, artist_id, name, duration_ms, album_name, album_image_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
                        [null, artistId, track.name, track.duration_ms || 0, albumName, albumImage]
                    );
                    songId = insertSong.rows[0].id;
                }
            }

            // Insert listening event (ignore duplicates)
            await pool.query(
                `INSERT INTO listening_history (user_id, song_id, played_at)
                 VALUES ($1,$2,$3)
                 ON CONFLICT ON CONSTRAINT unique_listening_event DO NOTHING`,
                [userId, songId, playedAtIso]
            );
        } catch (err) {
            console.warn("Failed to import item:", err.message || err);
        }
    }
}

module.exports = importHistory;
module.exports.importFromItems = importHistoryFromItems;