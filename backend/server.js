const express = require("express");
const pool = require("./database");

console.log(pool);

const app = express();

app.use(express.json());


app.get("/", (req, res) => {
    res.send("StreamDiva backend running!");
});


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


app.listen(3000, () => {
    console.log("Server running on port 3000");
});