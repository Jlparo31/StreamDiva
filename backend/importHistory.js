const axios = require("axios");
const pool = require("./database");


async function importHistory(accessToken, userId) {


    const response = await axios.get(

        "https://api.spotify.com/v1/me/player/recently-played",

        {
            headers: {

                Authorization:
                `Bearer ${accessToken}`

            },

            params: {

                limit: 50

            }

        }

    );


    const tracks = response.data.items;



    for (const item of tracks) {


        const track = item.track;

        const artist = track.artists[0] || { id: null, name: "Unknown Artist" };

        const albumImage = track.album?.images?.[0]?.url || null;

        const albumName = track.album?.name || null;



        // Insert artist
        const artistResult = await pool.query(

            `
            INSERT INTO artists
            (
                spotify_artist_id,
                name,
                image_url
            )

            VALUES ($1,$2,$3)

            ON CONFLICT (spotify_artist_id)

            DO UPDATE SET

                name = EXCLUDED.name,
                image_url = EXCLUDED.image_url

            RETURNING id
            `,

            [

                artist.id,

                artist.name,

                null

            ]

        );



        const artistId =
        artistResult.rows[0].id;





        // Insert song
        const songResult = await pool.query(

            `
            INSERT INTO songs
            (
                spotify_song_id,
                artist_id,
                name,
                duration_ms,
                album_name,
                album_image_url
            )

            VALUES ($1,$2,$3,$4,$5,$6)

            ON CONFLICT (spotify_song_id)

            DO UPDATE SET

                name = EXCLUDED.name,
                duration_ms = EXCLUDED.duration_ms,
                album_name = EXCLUDED.album_name,
                album_image_url = EXCLUDED.album_image_url

            RETURNING id

            `,

            [

                track.id,

                artistId,

                track.name,

                track.duration_ms,

                albumName,

                albumImage

            ]

        );



        const songId =
        songResult.rows[0].id;





        // Insert listening event
        await pool.query(

            `
            INSERT INTO listening_history
            (
                user_id,
                song_id,
                played_at
            )

            VALUES ($1,$2,$3)

            `,

            [

                userId,

                songId,

                item.played_at

            ]

        );


    }


}



module.exports = importHistory;