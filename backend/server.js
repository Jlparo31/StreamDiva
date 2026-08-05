const express = require("express");
const path = require("path");
const axios = require("axios");
const querystring = require("querystring");
const pool = require("./database");
const importHistory = require("./importHistory");
require("dotenv").config();


const app = express();
const spotifyCache = new Map();
const spotifyInFlight = new Map();
const importLocks = new Map();
const wikiCache = new Map();
const syncState = new Map();
let lastDashboardSnapshot = null;

const DASHBOARD_SYNC_COOLDOWN_MS = 120000;
const DASHBOARD_SYNC_MAX_BACKOFF_MS = 120000;
const DASHBOARD_STALE_WINDOW_MS = 180000;


app.use(express.json());
app.use(express.static(path.join(__dirname, "../frontend")));
app.disable("x-powered-by");


function getBearerToken(authHeader) {
    if (!authHeader) {
        return null;
    }


    return authHeader.startsWith("Bearer ")
        ? authHeader.replace("Bearer ", "")
        : authHeader;
}


async function getCachedSpotifyData(key, token, requestConfig = {}, ttlMs = 120000) {
    const cacheKey = `${key}:${token}:${JSON.stringify(requestConfig.params || {})}`;
    const cached = spotifyCache.get(cacheKey);
    const now = Date.now();


    if (cached && cached.expiresAt > now) {
        return cached.data;
    }


    if (spotifyInFlight.has(cacheKey)) {
        return spotifyInFlight.get(cacheKey);
    }


    const requestPromise = axios.get(
        `https://api.spotify.com/v1/${key}`,
        {
            ...requestConfig,
            headers: {
                ...(requestConfig.headers || {}),
                Authorization: `Bearer ${token}`
            },
            timeout: 5000
        }
    )
        .then((response) => {
            spotifyCache.set(cacheKey, {
                data: response.data,
                expiresAt: now + ttlMs
            });


            return response.data;
        })
        .finally(() => {
            spotifyInFlight.delete(cacheKey);
        });


    spotifyInFlight.set(cacheKey, requestPromise);

    try {
        return await requestPromise;
    } catch (error) {
        if (error.response?.status === 429 && cached?.data) {
            spotifyCache.set(cacheKey, {
                data: cached.data,
                expiresAt: now + ttlMs
            });

            return cached.data;
        }

        throw error;
    }
}

async function getLiveDashboardSnapshot(token) {
    const recentlyPlayedItems = [];
    let before = null;

    for (let page = 0; page < 4; page += 1) {
        const requestConfig = {
            params: {
                limit: 50
            }
        };

        if (before) {
            requestConfig.params.before = before;
        }

        const recentPlayedResponse = await getCachedSpotifyData(
            "me/player/recently-played",
            token,
            requestConfig,
            600000
        );

        const pageItems = recentPlayedResponse?.items || [];

        if (!pageItems.length) {
            break;
        }

        recentlyPlayedItems.push(...pageItems);

        const oldestPlayedAt = pageItems[pageItems.length - 1]?.played_at;
        if (!oldestPlayedAt) {
            break;
        }

        before = new Date(oldestPlayedAt).getTime() - 1;

        if (pageItems.length < 50) {
            break;
        }
    }

    const recentlyPlayed = recentlyPlayedItems
        .sort((a, b) => new Date(b.played_at || 0) - new Date(a.played_at || 0))
        .map((item) => {
        const track = item.track || {};
        const artist = track.artists?.[0] || {};

        return {
            song_name: track.name || "Unknown Track",
            artist_name: artist.name || "Unknown Artist",
            spotify_artist_id: artist.id || null,
            spotify_song_id: track.id || null,
            album_image_url: track.album?.images?.[0]?.url || "",
            artist_image_url: "",
            duration_ms: track.duration_ms || 0,
            played_at: item.played_at || null
        };
        });

    const artistAggregates = new Map();
    const songAggregates = new Map();

    for (const item of recentlyPlayed) {
        const artistKey = item.spotify_artist_id || item.artist_name;
        const songKey = item.spotify_song_id || `${item.song_name}:${item.artist_name}`;

        const artistEntry = artistAggregates.get(artistKey) || {
            artist_name: item.artist_name,
            spotify_artist_id: item.spotify_artist_id,
            image_url: "",
            play_count: 0,
            minutes_played: 0
        };

        if (!artistEntry.image_url && item.album_image_url) {
            artistEntry.image_url = item.album_image_url;
        }

        artistEntry.play_count += 1;
        artistEntry.minutes_played += (item.duration_ms || 0) / 60000;
        artistAggregates.set(artistKey, artistEntry);

        const songEntry = songAggregates.get(songKey) || {
            song_name: item.song_name,
            artist_name: item.artist_name,
            spotify_artist_id: item.spotify_artist_id,
            spotify_song_id: item.spotify_song_id,
            album_image_url: item.album_image_url || "",
            artist_image_url: "",
            play_count: 0,
            minutes_played: 0
        };

        songEntry.play_count += 1;
        songEntry.minutes_played += (item.duration_ms || 0) / 60000;
        songAggregates.set(songKey, songEntry);
    }

    const topArtists = Array.from(artistAggregates.values())
        .sort((a, b) => b.play_count - a.play_count || a.artist_name.localeCompare(b.artist_name))
        .sort((a, b) => b.minutes_played - a.minutes_played || a.artist_name.localeCompare(b.artist_name))
        .slice(0, 6)
        .map((artist) => ({
            ...artist,
            minutes_played: Number(artist.minutes_played.toFixed(1))
        }));

    const topArtistsWithImages = await Promise.all(
        topArtists.map(async (artist) => {
            if (!artist.spotify_artist_id) {
                return artist;
            }

            try {
                const artistDetails = await getCachedSpotifyData(
                    `artists/${artist.spotify_artist_id}`,
                    token,
                    {},
                    86400000
                );

                return {
                    ...artist,
                    image_url: artistDetails?.images?.[0]?.url || artist.image_url || ""
                };
            } catch (error) {
                console.warn("Artist image lookup failed:", error.response?.data || error.message);
                return artist;
            }
        })
    );

    const topSongs = Array.from(songAggregates.values())
        .sort((a, b) => b.minutes_played - a.minutes_played || a.song_name.localeCompare(b.song_name))
        .slice(0, 10)
        .map((song) => ({
            ...song,
            minutes_played: Number(song.minutes_played.toFixed(1))
        }));

    const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const weeklyMinutes = recentlyPlayed.reduce((total, item) => {
        if (!item.played_at) {
            return total;
        }

        const playedAtMs = new Date(item.played_at).getTime();

        if (Number.isNaN(playedAtMs) || playedAtMs < sevenDaysAgo) {
            return total;
        }

        return total + (item.duration_ms || 0);
    }, 0);

    const dayKey = (date) => {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, "0");
        const day = String(date.getDate()).padStart(2, "0");
        return `${year}-${month}-${day}`;
    };

    const dayMinutesMap = new Map();
    const dayLabelFormatter = new Intl.DateTimeFormat("en-US", { weekday: "short" });
    const today = new Date();

    for (let offset = 6; offset >= 0; offset -= 1) {
        const date = new Date(today);
        date.setHours(0, 0, 0, 0);
        date.setDate(date.getDate() - offset);
        dayMinutesMap.set(dayKey(date), 0);
    }

    for (const item of recentlyPlayed) {
        if (!item.played_at) {
            continue;
        }

        const playedAt = new Date(item.played_at);
        if (Number.isNaN(playedAt.getTime())) {
            continue;
        }

        const key = dayKey(playedAt);
        if (!dayMinutesMap.has(key)) {
            continue;
        }

        const previous = dayMinutesMap.get(key) || 0;
        dayMinutesMap.set(key, previous + (item.duration_ms || 0));
    }

    const dailyMinutes = Array.from(dayMinutesMap.entries()).map(([key, valueMs]) => {
        const date = new Date(`${key}T00:00:00`);
        return {
            day: dayLabelFormatter.format(date),
            minutes: Math.round(valueMs / 60000)
        };
    });

    return {
        weeklyMinutes: Math.round(weeklyMinutes / 60000),
        dailyMinutes,
        lastUpdated: recentlyPlayed[0]?.played_at || null,
        topArtists: topArtistsWithImages,
        topSongs,
        history: recentlyPlayed,
        recentlyPlayed
    };
}

app.get("/login", (req, res) => {
    const scopes = [
        "user-read-private",
        "user-read-recently-played",
        "user-top-read",
        "user-read-currently-playing",
        "user-read-playback-state"
    ].join(" ");


    const authURL =
        "https://accounts.spotify.com/authorize?" +
        querystring.stringify({
            response_type: "code",
            client_id: process.env.SPOTIFY_CLIENT_ID,
            scope: scopes,
            redirect_uri: process.env.SPOTIFY_REDIRECT_URI
        });


    res.redirect(authURL);
});


app.get("/callback", async (req, res) => {
    const code = req.query.code;


    if (!code) {
        return res.status(400).send("Missing authorization code");
    }


    try {
        const tokenResponse = await axios.post(
            "https://accounts.spotify.com/api/token",
            new URLSearchParams({
                grant_type: "authorization_code",
                code,
                redirect_uri: process.env.SPOTIFY_REDIRECT_URI
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Authorization:
                        "Basic " +
                        Buffer.from(
                            process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
                        ).toString("base64")
                },
                timeout: 5000
            }
        );


        const accessToken = tokenResponse.data.access_token;
        const refreshToken = tokenResponse.data.refresh_token;
        console.log("Spotify authentication successful");

        syncState.clear();
        importLocks.clear();

        const redirectParams = new URLSearchParams({
            token: accessToken
        });

        if (refreshToken) {
            redirectParams.set("refreshToken", refreshToken);
        }

        res.redirect("/?" + redirectParams.toString());
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).send("Spotify authentication failed");
    }
});

app.post("/refresh-token", async (req, res) => {
    const refreshToken = req.body?.refreshToken;

    if (!refreshToken) {
        return res.status(400).json({ message: "Missing refresh token" });
    }

    try {
        const tokenResponse = await axios.post(
            "https://accounts.spotify.com/api/token",
            new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: refreshToken
            }),
            {
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                    Authorization:
                        "Basic " +
                        Buffer.from(
                            process.env.SPOTIFY_CLIENT_ID + ":" + process.env.SPOTIFY_CLIENT_SECRET
                        ).toString("base64")
                },
                timeout: 5000
            }
        );

        return res.json({
            accessToken: tokenResponse.data.access_token,
            refreshToken: tokenResponse.data.refresh_token || refreshToken
        });
    } catch (error) {
        console.error("Token refresh failed:", error.response?.data || error.message);
        return res.status(error.response?.status || 500).json({
            message: "Token refresh failed",
            error: error.response?.data || error.message
        });
    }
});


app.get("/now-playing", async (req, res) => {
    res.set("Cache-Control", "no-store");

    try {
        const token = getBearerToken(req.headers.authorization);

        if (!token) {
            return res.status(401).json({ message: "No Spotify token provided" });
        }

        const response = await axios.get("https://api.spotify.com/v1/me/player/currently-playing", {
            headers: { Authorization: `Bearer ${token}` }
        });

        if (response.status === 204 || !response.data || !response.data.item) {
            return res.json({ is_playing: false });
        }

        const { item, is_playing, progress_ms } = response.data;

        return res.json({
            is_playing,
            progress_ms,
            duration_ms: item.duration_ms,
            track_name: item.name,
            artist_name: item.artists.map(a => a.name).join(", "),
            album_art: item.album.images[0]?.url || null,
            spotify_url: item.external_urls?.spotify || null
        });
    } catch (error) {
        // 204 from axios throws on some versions — treat as not playing
        if (error.response?.status === 204) {
            return res.json({ is_playing: false });
        }
        console.error("Now playing request failed:", error.response?.data || error.message);
        return res.status(error.response?.status || 500).json({
            message: "Spotify request failed",
            error: error.response?.data || error.message
        });
    }
});


app.get("/spotify-user", async (req, res) => {
    res.set("Cache-Control", "no-store");


    try {
        const token = getBearerToken(req.headers.authorization);


        if (!token) {
            return res.status(401).json({ message: "No Spotify token provided" });
        }


        const response = await getCachedSpotifyData("me", token, {}, 300000);


        return res.json({
            id: response.id,
            display_name: response.display_name,
            email: response.email,
            images: response.images
        });
    } catch (error) {
        console.error("Spotify user request failed:", error.response?.data || error.message);


        return res.status(error.response?.status || 500).json({
            message: "Spotify request failed",
            error: error.response?.data || error.message
        });
    }
});


app.get("/dashboard", async (req, res) => {
    res.set("Cache-Control", "no-store");


    try {
        const token = getBearerToken(req.headers.authorization);

        if (!token) {
            return res.status(401).json({ message: "No Spotify token provided" });
        }

        const liveDashboard = await getLiveDashboardSnapshot(token);

        lastDashboardSnapshot = {
            ...liveDashboard,
            syncStatus: "live"
        };

        return res.json({
            ...liveDashboard,
            syncStatus: "live"
        });
    } catch (error) {
        if (error.response?.status === 429 && lastDashboardSnapshot) {
            return res.json({
                ...lastDashboardSnapshot,
                syncStatus: "cached_rate_limited"
            });
        }

        if (error.response?.status === 429) {
            return res.json({
                weeklyMinutes: 0,
                lastUpdated: null,
                topArtists: [],
                topSongs: [],
                history: [],
                recentlyPlayed: [],
                syncStatus: "empty_rate_limited"
            });
        }

        console.error("Dashboard request failed:", error.response?.data || error.message);
        return res.status(error.response?.status || 500).json({
            message: "Dashboard request failed",
            error: error.response?.data || error.message
        });
    }
});


app.post("/import-history", async (req, res) => {
    try {
        const token = getBearerToken(req.headers.authorization);

        if (!token) {
            return res.status(401).json({ message: "No Spotify token provided" });
        }

        const profile = await getCachedSpotifyData("me", token, {}, 300000);
        const userId = req.headers["x-user-id"] || profile.id;


        // Check if an import is already in progress for this user
        if (importLocks.has(userId)) {
            return res.status(202).json({ message: "Import already in progress" });
        }


        const importPromise = importHistory(token, userId)
            .then(() => {
                const completedAt = Date.now();
                syncState.set(userId, {
                    lastSyncedAt: completedAt,
                    nextAllowedAt: completedAt + DASHBOARD_SYNC_COOLDOWN_MS
                });

                return { message: "History imported successfully" };
            })
            .finally(() => {
                importLocks.delete(userId);
            });


        importLocks.set(userId, importPromise);


        const result = await importPromise;


        return res.json(result);
    } catch (error) {
        console.error("History import failed:", error.response?.data || error.message);

        return res.status(error.response?.status || 500).json({
            message: "History import failed",
            error: error.response?.data || error.message
        });
    }
});


async function ensureSongAlbumColumns() {
    await pool.query(`
        ALTER TABLE songs
        ADD COLUMN IF NOT EXISTS album_image_url TEXT,
        ADD COLUMN IF NOT EXISTS album_name TEXT
    `);
}

ensureSongAlbumColumns().catch((error) => {
    console.error("Schema init failed:", error.message);
});


app.listen(3000, () => {
    console.log("Server running on port 3000");
});

async function getArtistBiography(artistName) {
    const cacheKey = artistName.trim().toLowerCase();
    const cached = wikiCache.get(cacheKey);
    const now = Date.now();

    if (cached && cached.expiresAt > now) {
        return cached.text;
    }

    const response = await axios.get(
        `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artistName)}`,
        {
            timeout: 5000
        }
    );

    const biography = response.data.extract || response.data.description || "Biography unavailable.";

    wikiCache.set(cacheKey, {
        text: biography,
        expiresAt: now + 3600000
    });

    return biography;
}