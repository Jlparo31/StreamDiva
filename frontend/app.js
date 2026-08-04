const params = new URLSearchParams(window.location.search);

const token = params.get("token");


if (token) {

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

const searchButton = document.getElementById("searchButton");
const searchInput = document.getElementById("artistSearch");
const results = document.getElementById("artistResults");


// Load dashboard data when page opens
window.onload = () => {

    loadRecentlyPlayed();

};



async function loadRecentlyPlayed() {

    const container = document.getElementById("recentlyPlayed");


    try {

        const response = await fetch("/recently-played", {

            headers: {

                Authorization:
                "Bearer " + localStorage.getItem("spotifyToken")

            }

        });


        const songs = await response.json();


        container.innerHTML = "";


        songs.forEach(item => {

            const track = item.track;


            container.innerHTML += `

    <a 
        href="${track.external_urls.spotify}" 
        target="_blank"
        class="song-link"
    >

        <div class="song-card">

            <img 
            src="${track.album.images[0].url}" 
            >

            <div>

                <h3>${track.name}</h3>

                <p>${track.artists[0].name}</p>

            </div>

        </div>

    </a>

`;
});

    } catch(error) {

        console.error(error);

        container.innerHTML =
        "Unable to load recently played songs";

    }

}




searchButton.addEventListener("click", async () => {

    const artist = searchInput.value.trim();


    if (!artist) {

        results.innerHTML =
            "<p>Please enter an artist name</p>";

        return;

    }


    try {

        const response = await fetch(
            `/artist/${encodeURIComponent(artist)}`
        );


        const data = await response.json();



        results.innerHTML = `

            <div class="artist-card">

                <h2>${data.artist}</h2>

                <p>
                    First listened:
                    ${data.first_listened || "Never"}
                </p>

                <p>
                    Total streams:
                    ${data.total_streams || 0}
                </p>

                <p>
                    Minutes listened:
                    ${Math.round(data.minutes_listened || 0)}
                </p>

                <h3>
                    Top Tracks
                </h3>

                <ol>

                    ${
                        data.top_tracks?.map(track =>

                            `
                            <li>
                                ${track.song}
                                -
                                ${track.streams} streams
                            </li>
                            `

                        ).join("")
                        ||
                        "<li>No songs found</li>"
                    }

                </ol>

            </div>

        `;


    } catch(error) {

        console.error(error);

        results.innerHTML =
            "<p>Error loading artist data</p>";

    }

});