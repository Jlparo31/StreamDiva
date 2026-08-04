const express = require("express");
const path = require("path");
const axios = require("axios");
const querystring = require("querystring");
const pool = require("./database");
const importHistory = require("./importHistory");

const app = express();

app.use(express.json());


// Serve frontend files
app.use(express.static(path.join(__dirname, "../frontend")));


// Test PostgreSQL connection
app.get("/test-db", async (req, res) => {

    try {

        const result = await pool.query(
            "SELECT * FROM artists"
        );

        res.json(result.rows);

    } catch(error) {

        console.error(error);
        res.status(500).send("Database error");

    }

});



/*
    SPOTIFY LOGIN
*/

// Send user to Spotify authorization
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





// Spotify callback
app.get("/callback", async (req, res) => {

    const code = req.query.code;


    try {

        const tokenResponse = await axios.post(

            "https://accounts.spotify.com/api/token",

            new URLSearchParams({

                grant_type: "authorization_code",
                code: code,
                redirect_uri: process.env.SPOTIFY_REDIRECT_URI

            }),

            {

                headers: {

                    "Content-Type":
                    "application/x-www-form-urlencoded",

                    Authorization:
                    "Basic " +
                    Buffer.from(

                        process.env.SPOTIFY_CLIENT_ID +
                        ":" +
                        process.env.SPOTIFY_CLIENT_SECRET

                    ).toString("base64")

                }

            }

        );


        const accessToken = tokenResponse.data.access_token;


        res.redirect(
    "/?token=" + accessToken
);


    } catch(error) {

        console.error(
            error.response?.data || error.message
        );

        res.status(500).send(
            "Spotify authentication failed"
        );

    }

});





/*
    GET SPOTIFY USER
*/

app.get("/spotify-user", async (req, res) => {

    try {

        const response = await axios.get(

            "https://api.spotify.com/v1/me",

            {

                headers: {

                    Authorization:
                    req.headers.authorization

                }

            }

        );


        res.json(response.data);


    } catch(error) {

        console.error(
            error.response?.data || error.message
        );

        res.status(500).send(
            "Could not get Spotify user"
        );

    }

});





/*
    IMPORT SPOTIFY LISTENING HISTORY
*/

app.get("/import-history", async (req, res) => {

    try {

        const authHeader = req.headers.authorization;


        if (!authHeader) {

            return res.status(401).send(
                "Missing Spotify access token"
            );

        }


        const accessToken = authHeader.replace(
            "Bearer ",
            ""
        );



        // Get Spotify user
        const userResponse = await axios.get(

            "https://api.spotify.com/v1/me",

            {

                headers: {

                    Authorization:
                    `Bearer ${accessToken}`

                }

            }

        );


        const spotifyUser = userResponse.data;



        // Insert/update user
        const userResult = await pool.query(

            `
            INSERT INTO users
            (
                spotify_user_id,
                display_name
            )

            VALUES ($1,$2)

            ON CONFLICT (spotify_user_id)

            DO UPDATE SET

                display_name =
                EXCLUDED.display_name

            RETURNING id
            `,

            [

                spotifyUser.id,
                spotifyUser.display_name

            ]

        );


        const userId = userResult.rows[0].id;



        // Import listening history
        await importHistory(
            accessToken,
            userId
        );



        res.json({

            message:
            "Listening history imported successfully",

            user:
            spotifyUser.display_name

        });



    } catch(error) {

        console.error(
            error.response?.data || error.message
        );


        res.status(500).send(
            "Import failed"
        );

    }

});

/*
    GET RECENTLY PLAYED SONGS
*/

app.get("/recently-played", async (req, res) => {

    try {

        const response = await axios.get(

            "https://api.spotify.com/v1/me/player/recently-played",

            {
                headers: {
                    Authorization: req.headers.authorization
                },

                params: {
                    limit: 10
                }
            }

        );


        res.json(response.data.items);


    } catch(error) {

        console.error(
            error.response?.data || error.message
        );

        res.status(500).json({

    message: "Could not get recently played songs",

    error: error.response?.data || error.message

});

    }

});



/*
    SEARCH USER LISTENING DATA

    Searches PostgreSQL, not Spotify
*/

app.get("/artist/:name", async (req, res) => {

    try {

        const artistName = req.params.name;


        // Get artist summary
        const artistResult = await pool.query(

            `
            SELECT

                a.name AS artist,

                MIN(lh.played_at)
                AS first_listened,

                COUNT(lh.id)
                AS total_streams,

                COALESCE(
                    SUM(s.duration_ms) / 60000,
                    0
                )
                AS minutes_listened


            FROM artists a


            LEFT JOIN songs s
            ON a.id = s.artist_id


            LEFT JOIN listening_history lh
            ON s.id = lh.song_id


            WHERE a.name ILIKE $1


            GROUP BY a.name

            `,

            [
                '%${artistName}$%'
            ]

        );



        // Artist not found
        if (artistResult.rows.length === 0) {

            return res.json({

                artist: artistName,

                first_listened: null,

                total_streams: 0,

                minutes_listened: 0,

                top_tracks: []

            });

        }



        // Get top 5 songs
        const songsResult = await pool.query(

            `
            SELECT

                s.name AS song,

                COUNT(lh.id)
                AS streams


            FROM songs s


            JOIN artists a
            ON s.artist_id = a.id


            LEFT JOIN listening_history lh
            ON s.id = lh.song_id


            WHERE a.name ILIKE $1


            GROUP BY s.name


            ORDER BY streams DESC


            LIMIT 5

            `,

            [
                artistName
            ]

        );



        res.json({

            artist:
            artistResult.rows[0].artist,

            first_listened:
            artistResult.rows[0].first_listened,

            total_streams:
            Number(
                artistResult.rows[0].total_streams
            ),

            minutes_listened:
            Number(
                artistResult.rows[0].minutes_listened
            ),

            top_tracks:
            songsResult.rows

        });



    } catch(error) {

        console.error(error);

        res.status(500).send(
            "Database error"
        );

    }

});





// Start server
app.listen(3000, () => {

    console.log(
        "Server running on port 3000"
    );

});