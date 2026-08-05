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


    return requestPromise;
}


app.get("/login", (req, res) => {
    const scopes = [
        "user-read-private",
        "user-read-recently-played",
        "user-top-read"
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
        console.log("Spotify authentication successful");


        res.redirect("/?token=" + encodeURIComponent(accessToken));
    } catch (error) {
        console.error(error.response?.data || error.message);
        res.status(500).send("Spotify authentication failed");
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
        const userId = req.headers["x-user-id"] || req.query.userId || process.env.DEFAULT_DB_USER_ID || 1;


        const [historyResult, topArtistsResult, topSongsResult, weeklyMinutesResult] = await Promise.all([
            pool.query(
                `
                    SELECT
                        s.name AS song_name,
                        a.name AS artist_name,
                        a.spotify_artist_id,
                        s.spotify_song_id,
                        COALESCE(s.album_image_url, '') AS album_image_url,
                        COALESCE(a.image_url, '') AS artist_image_url,
                        s.duration_ms,
                        lh.played_at
                    FROM listening_history lh
                    JOIN songs s ON s.id = lh.song_id
                    JOIN artists a ON a.id = s.artist_id
                    WHERE lh.user_id = $1
                    ORDER BY lh.played_at DESC
                    LIMIT 24
                `,
                [userId]
            ),
            pool.query(
                `
                    SELECT
                        a.name AS artist_name,
                        a.spotify_artist_id,
                        COUNT(*) AS play_count,
                        COALESCE(a.image_url, '') AS image_url
                    FROM listening_history lh
                    JOIN songs s ON s.id = lh.song_id
                    JOIN artists a ON a.id = s.artist_id
                    WHERE lh.user_id = $1
                      AND lh.played_at >= NOW() - INTERVAL '7 days'
                    GROUP BY a.id, a.name, a.image_url, a.spotify_artist_id
                    ORDER BY play_count DESC, a.name ASC
                    LIMIT 5
                `,
                [userId]
            ),
            pool.query(
                `
                    SELECT
                        s.name AS song_name,
                        a.name AS artist_name,
                        a.spotify_artist_id,
                        s.spotify_song_id,
                        COALESCE(s.album_image_url, '') AS album_image_url,
                        COALESCE(a.image_url, '') AS artist_image_url,
                        COUNT(*) AS play_count,
                        ROUND(SUM(s.duration_ms) / 60000.0, 1) AS minutes_played
                    FROM listening_history lh
                    JOIN songs s ON s.id = lh.song_id
                    JOIN artists a ON a.id = s.artist_id
                    WHERE lh.user_id = $1
                      AND lh.played_at >= NOW() - INTERVAL '7 days'
                    GROUP BY s.id, s.name, a.name, a.spotify_artist_id, s.spotify_song_id, s.album_image_url, a.image_url
                    ORDER BY play_count DESC, minutes_played DESC
                    LIMIT 5
                `,
                [userId]
            ),
            pool.query(
                `
                    SELECT
                        COALESCE(ROUND(SUM(s.duration_ms) / 60000.0), 0) AS weekly_minutes
                    FROM listening_history lh
                    JOIN songs s ON s.id = lh.song_id
                    WHERE lh.user_id = $1
                      AND lh.played_at >= NOW() - INTERVAL '7 days'
                `,
                [userId]
            )
        ]);


        return res.json({
            weeklyMinutes: Number(weeklyMinutesResult.rows[0]?.weekly_minutes || 0),
            topArtists: topArtistsResult.rows,
            topSongs: topSongsResult.rows,
            history: historyResult.rows,
            recentlyPlayed: historyResult.rows
        });
    } catch (error) {
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
            .then(() => ({ message: "History imported successfully" }))
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