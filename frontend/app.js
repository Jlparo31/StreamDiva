/* GET SPOTIFY TOKEN FROM URL */


const params =
    new URLSearchParams(
        window.location.search
    );


const token =
    params.get("token");



if(token){


    localStorage.setItem(

        "spotifyToken",

        token

    );



    window.history.replaceState(

        {},

        document.title,

        "/"

    );


}





/* AUTHENTICATION CHECK */

document.addEventListener(

    "DOMContentLoaded",

    async ()=>{


        const spotifyToken =

        localStorage.getItem(

            "spotifyToken"

        );



        if(!spotifyToken){


            window.location.href =

            "/login";


            return;

        }



        const importButton =

            document.getElementById(

                "importButton"

            );

    let isImporting = false;



        if(importButton){


            importButton.addEventListener(


                "click",


                async ()=>{


                    if (isImporting) {

                        return;

                    }


                    isImporting = true;

                    importButton.disabled = true;

                    importButton.textContent = "Importing...";



                    try{


                        const response = await fetch(


                            "/import-history",


                            {

                                method: "POST",


                                headers: {


                                    Authorization:


                                    `Bearer ${spotifyToken}`,


                                    "x-user-id": "1"


                                }


                            }


                        );


                        const result = await response.json();


                        console.log(


                            "Import result:",


                            result


                        );



                        await loadDashboard();


                    }catch(error){


                        console.error(


                            "Import history error:",


                            error


                        );


                    }finally{


                        isImporting = false;


                        importButton.disabled = false;


                        importButton.textContent = "Import History";


                    }


                }


            );


        }



        console.log(

            "Spotify token found"

        );



        await loadDashboard();


    }

);





/* LOAD DASHBOARD DATA */


async function loadDashboard() {


    try {


        const token =

            localStorage.getItem(

                "spotifyToken"

            );



        const response =

            await fetch(

                "/dashboard",

                {

                    headers:{

                        Authorization:

                        `Bearer ${token}`,

                        "x-user-id": "1"

                    },

                    cache: "no-store"

                }

            );



        const data =

            await response.json();



        renderTopArtist(data.topArtists?.[0]);

        renderTopSongs(data.topSongs || []);

        renderTopAlbums(data.topArtists || []);

        renderWeeklyMinutes(data.weeklyMinutes || 0);

        renderRecentlyPlayed(data.recentlyPlayed || []);



        const recentItems = (data.recentlyPlayed || []).slice(0, 24);
        recentSongsCollection = recentItems;
        recentSongsPage = 0;

        renderRecentlyPlayed(recentSongsCollection);
        bindRecentlyPlayedControls();



    }catch(error){


        console.error(

            "Dashboard error:",

            error

        );


    }


}



function renderTopArtist(topArtist) {
    const artistNameEl = document.getElementById("topArtist");
    const imageContainer = document.getElementById("topArtistImages");

    if (!topArtist) {
        return;
    }

    const artistUrl = topArtist.spotify_artist_id
        ? `https://open.spotify.com/artist/${topArtist.spotify_artist_id}`
        : null;

    if (artistNameEl) {
        artistNameEl.innerHTML = artistUrl
            ? `<a href="${artistUrl}" target="_blank" rel="noopener noreferrer">${topArtist.artist_name}</a>`
            : topArtist.artist_name;
    }

    if (imageContainer && topArtist.image_url) {
        if (artistUrl) {
            imageContainer.innerHTML = `<a href="${artistUrl}" target="_blank" rel="noopener noreferrer"><img src="${topArtist.image_url}" alt="${topArtist.artist_name}" /></a>`;
        } else {
            imageContainer.innerHTML = `<img src="${topArtist.image_url}" alt="${topArtist.artist_name}" />`;
        }
    }
}

function renderTopAlbums(topArtists) {
    const albumsContainer = document.getElementById("topAlbums");

    if (!albumsContainer) {
        return;
    }

    if (!topArtists.length) {
        albumsContainer.textContent = "No album history yet";
        return;
    }

    albumsContainer.innerHTML = topArtists
        .map((artist) => {
            const imageUrl = artist.image_url;
            const artistUrl = buildArtistSpotifyUrl(artist);

            const image = imageUrl
                ? artistUrl
                    ? `<a href="${artistUrl}" target="_blank" rel="noopener noreferrer"><img src="${artist.image_url}" alt="${artist.artist_name}" /></a>`
                    : `<img src="${artist.image_url}" alt="${artist.artist_name}" />`
                : "";

            return `<div class="album-item">${image}<span>${artist.artist_name}</span></div>`;
        })
        .join("");
}

function renderTopSongs(topSongs) {

    const list = document.getElementById("topSongsList");

    if (!list) {
        return;
    }

    if (!topSongs.length) {
        list.innerHTML = "No recent songs logged yet";
        return;
    }

    list.innerHTML = topSongs
        .map((song, index) => {
            const imageSrc = song.album_image_url || song.artist_image_url || "https://placehold.co/64x64/1DB954/111111?text=♫";
            const songUrl = buildTrackSpotifyUrl(song);
            const artistUrl = buildArtistSpotifyUrl(song);

            const imageMarkup = songUrl
                ? `<a href="${songUrl}" target="_blank" rel="noopener noreferrer"><img src="${imageSrc}" alt="${song.song_name}" class="song-art" /></a>`
                : `<img src="${imageSrc}" alt="${song.song_name}" class="song-art" />`;

            const songText = songUrl
                ? `<a href="${songUrl}" target="_blank" rel="noopener noreferrer">${song.song_name}</a>`
                : song.song_name;

            const artistText = artistUrl
                ? `<a href="${artistUrl}" target="_blank" rel="noopener noreferrer">${song.artist_name}</a>`
                : song.artist_name;

            return `
                <li class="top-song-item">
                    ${imageMarkup}
                    <span>${index + 1}. ${songText} — ${artistText}</span>
                </li>
            `;
        })
        .join("");
}

function renderWeeklyMinutes(minutes) {


    const weeklyMinutesEl =

        document.getElementById(

            "weeklyMinutes"

        );



    if (weeklyMinutesEl) {

        weeklyMinutesEl.textContent = `${minutes} minutes`;

    }

}



function bindRecentlyPlayedControls() {
    const prevButton = document.getElementById("recentlyPlayedPrev");
    const nextButton = document.getElementById("recentlyPlayedNext");

    if (!prevButton || !nextButton) {
        return;
    }

    const maxPages = Math.max(1, Math.ceil(recentSongsCollection.length / recentSongsPageSize));

    prevButton.disabled = recentSongsPage === 0;
    nextButton.disabled = recentSongsPage >= maxPages - 1;

    prevButton.onclick = () => {
        if (recentSongsPage > 0) {
            recentSongsPage -= 1;
            renderRecentlyPlayed(recentSongsCollection);
        }
    };

    nextButton.onclick = () => {
        if (recentSongsPage < maxPages - 1) {
            recentSongsPage += 1;
            renderRecentlyPlayed(recentSongsCollection);
        }
    };
}

function renderRecentlyPlayed(items) {
    const recentlyPlayedEl = document.getElementById("recentlyPlayed");

    if (!recentlyPlayedEl) {
        return;
    }

    if (!items.length) {
        recentlyPlayedEl.textContent = "No recently played songs available";
        bindRecentlyPlayedControls();
        return;
    }

    const maxPages = Math.min(3, Math.ceil(items.length / recentSongsPageSize));
    const safePage = Math.min(recentSongsPage, maxPages - 1);
    recentSongsPage = safePage;

    const start = safePage * recentSongsPageSize;
    const pageItems = items.slice(start, start + recentSongsPageSize);

    recentlyPlayedEl.innerHTML = pageItems
        .map((item) => {
            const imageSrc = item.album_image_url || item.artist_image_url || "https://placehold.co/64x64/1DB954/111111?text=♫";
            const songUrl = buildTrackSpotifyUrl(item);
            const artistUrl = buildArtistSpotifyUrl(item);

            const imageMarkup = songUrl
                ? `<a href="${songUrl}" target="_blank" rel="noopener noreferrer"><img src="${imageSrc}" alt="${item.song_name}" class="song-art" /></a>`
                : `<img src="${imageSrc}" alt="${item.song_name}" class="song-art" />`;

            const songText = songUrl
                ? `<a href="${songUrl}" target="_blank" rel="noopener noreferrer">${item.song_name}</a>`
                : item.song_name;

            const artistText = artistUrl
                ? `<a href="${artistUrl}" target="_blank" rel="noopener noreferrer">${item.artist_name}</a>`
                : item.artist_name;

            return `
                <div class="recent-song">
                    ${imageMarkup}
                    <div>
                        <strong>${songText}</strong>
                        <span> — ${artistText}</span>
                    </div>
                </div>
            `;
        })
        .join("");

    bindRecentlyPlayedControls();
}

function buildArtistSpotifyUrl(artist) {
    if (artist?.spotify_artist_id) {
        return `https://open.spotify.com/artist/${artist.spotify_artist_id}`;
    }

    if (artist?.artist_name) {
        return `https://open.spotify.com/search/${encodeURIComponent(artist.artist_name)}`;
    }

    return null;
}

function buildTrackSpotifyUrl(song) {
    if (song?.spotify_song_id) {
        return `https://open.spotify.com/track/${song.spotify_song_id}`;
    }

    if (song?.song_name || song?.artist_name) {
        const query = [song.song_name, song.artist_name].filter(Boolean).join(" ");
        return `https://open.spotify.com/search/${encodeURIComponent(query)}`;
    }

    return null;
}


/* Pagination state for recent songs */


let recentSongsPage = 0;
const recentSongsPageSize = 8;
let recentSongsCollection = [];