const axios = require("axios");
require("dotenv").config();


async function getSpotifyToken() {

    const response = await axios.post(
        "https://accounts.spotify.com/api/token",
        new URLSearchParams({
            grant_type: "client_credentials"
        }),
        {
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
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

    return response.data.access_token;
}


async function searchArtist(name) {

    const token = await getSpotifyToken();

    const searchResponse = await axios.get(
        "https://api.spotify.com/v1/search",
        {
            headers: {
                Authorization: `Bearer ${token}`
            },
            params: {
                q: name,
                type: "artist",
                limit: 1
            }
        }
    );


    const artist = searchResponse.data.artists.items[0];


    if (!artist) {
        return null;
    }


    const artistResponse = await axios.get(
        `https://api.spotify.com/v1/artists/${artist.id}`,
        {
            headers: {
                Authorization: `Bearer ${token}`
            }
        }
    );

return artistResponse.data;
}


module.exports = {
    searchArtist
};