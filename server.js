const express = require("express");
const http = require("http");
const https = require("https");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.static(__dirname));


// ======================================================
// SLOW TIDE LYRICS TV
// ======================================================

app.get("/lyrics", (req, res) => {
    res.sendFile(
        path.join(__dirname, "lyrics.html")
    );
});

app.get("/lyrics.html", (req, res) => {
    res.sendFile(
        path.join(__dirname, "lyrics.html")
    );
});


const PORT = process.env.PORT || 3000;


// ======================================================
// SLOW TIDE NOW PLAYING SERVER
// Da Obsidian Court
// ======================================================


// Default station
let currentStream =
    "http://mogullustradio.shoutcastnet.com:30800/stream";

let currentTitle =
    "Connecting to Slow Tide...";

let checking = false;


// ======================================================
// LYRICS CACHE
// ======================================================

let lyricsCache = {

    title: null,

    result: null,

    updated: 0
};


// ======================================================
// CLEAN TEXT / HTML
// ======================================================

function decodeText(value) {

    if (value === undefined || value === null)
        return null;

    let text = String(value);

    text = text
        .replace(/&amp;/gi, "&")
        .replace(/&quot;/gi, "\"")
        .replace(/&#39;/gi, "'")
        .replace(/&#039;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&nbsp;/gi, " ")

        // Common broken UTF-8 punctuation
        .replace(/â€“/g, "-")
        .replace(/â€”/g, "-")
        .replace(/âˆ’/g, "-")
        .replace(/â€™/g, "'")
        .replace(/â€œ/g, "\"")
        .replace(/â€/g, "\"")
        .replace(/â€¦/g, "...")
        .replace(/â\?\?/g, "-")

        .replace(/\0/g, "")
        .replace(/\s+/g, " ")
        .trim();

    return text || null;
}


function stripHTML(value) {

    if (!value)
        return null;

    return decodeText(
        String(value)
            .replace(/<script[\s\S]*?<\/script>/gi, " ")
            .replace(/<style[\s\S]*?<\/style>/gi, " ")
            .replace(/<[^>]+>/g, " ")
    );
}


function cleanTitle(value) {

    let title = decodeText(value);

    if (!title)
        return null;

    const lower = title.toLowerCase();

    if (
        lower === "unknown" ||
        lower === "null" ||
        lower === "undefined"
    ) {
        return null;
    }

    return title;
}


// ======================================================
// BASIC HTTP FETCH
// ======================================================

function fetchText(urlString, timeout = 8000, redirects = 0) {

    return new Promise((resolve, reject) => {

        if (redirects > 5) {
            reject(new Error("Too many redirects"));
            return;
        }

        let url;

        try {
            url = new URL(urlString);
        }
        catch (error) {
            reject(error);
            return;
        }

        const client =
            url.protocol === "https:"
                ? https
                : http;

        const options = {

            hostname: url.hostname,

            port:
                url.port ||
                (url.protocol === "https:" ? 443 : 80),

            path:
                url.pathname + url.search,

            method: "GET",

            headers: {

                "User-Agent":
                    "SlowTideLyricsTV/1.0",

                "Accept":
                    "text/html,application/json,text/plain,*/*",

                "Connection":
                    "close"
            }
        };


        const request =
            client.request(options, response => {

                // --------------------------------------
                // REDIRECT
                // --------------------------------------

                if (
                    response.statusCode >= 300 &&
                    response.statusCode < 400 &&
                    response.headers.location
                ) {

                    response.destroy();

                    const redirectURL =
                        new URL(
                            response.headers.location,
                            urlString
                        ).toString();

                    fetchText(
                        redirectURL,
                        timeout,
                        redirects + 1
                    )
                    .then(resolve)
                    .catch(reject);

                    return;
                }


                // --------------------------------------
                // HTTP ERROR
                // --------------------------------------

                if (
                    response.statusCode &&
                    response.statusCode >= 400
                ) {

                    response.resume();

                    reject(
                        new Error(
                            "HTTP " +
                            response.statusCode
                        )
                    );

                    return;
                }


                const chunks = [];
                let totalLength = 0;


                response.on("data", chunk => {

                    if (!Buffer.isBuffer(chunk)) {
                        chunk = Buffer.from(chunk);
                    }

                    chunks.push(chunk);

                    totalLength += chunk.length;


                    if (totalLength > 2000000) {
                        response.destroy();
                    }
                });


                response.on("end", () => {

                    const buffer =
                        Buffer.concat(chunks);

                    resolve(
                        buffer.toString("utf8")
                    );
                });


                response.on(
                    "error",
                    reject
                );
            });


        request.on(
            "error",
            reject
        );


        request.setTimeout(
            timeout,
            () => {

                request.destroy();

                reject(
                    new Error(
                        "Request timed out"
                    )
                );
            }
        );


        request.end();
    });
}


// ======================================================
// READ ICY STREAM METADATA
// ======================================================

function getIcyStreamTitle(streamUrl, redirects = 0) {

    return new Promise((resolve, reject) => {

        if (redirects > 5) {

            reject(
                new Error(
                    "Too many stream redirects"
                )
            );

            return;
        }


        let url;

        try {
            url = new URL(streamUrl);
        }
        catch (error) {
            reject(error);
            return;
        }


        const client =
            url.protocol === "https:"
                ? https
                : http;


        const options = {

            hostname: url.hostname,

            port:
                url.port ||
                (url.protocol === "https:" ? 443 : 80),

            path:
                url.pathname + url.search,

            method: "GET",

            headers: {

                "Icy-MetaData": "1",

                "User-Agent":
                    "Mozilla/5.0 SlowTideNowPlaying",

                "Accept":
                    "*/*",

                "Connection":
                    "close"
            }
        };


        let settled = false;


        function success(value) {

            if (settled)
                return;

            settled = true;

            resolve(value);
        }


        function failure(error) {

            if (settled)
                return;

            settled = true;

            reject(error);
        }


        const request =
            client.request(options, response => {

                // --------------------------------------
                // REDIRECT
                // --------------------------------------

                if (
                    response.statusCode >= 300 &&
                    response.statusCode < 400 &&
                    response.headers.location
                ) {

                    response.destroy();

                    const redirectURL =
                        new URL(
                            response.headers.location,
                            streamUrl
                        ).toString();

                    getIcyStreamTitle(
                        redirectURL,
                        redirects + 1
                    )
                    .then(success)
                    .catch(failure);

                    return;
                }


                // --------------------------------------
                // HTTP ERROR
                // --------------------------------------

                if (
                    response.statusCode &&
                    response.statusCode >= 400
                ) {

                    response.destroy();

                    failure(
                        new Error(
                            "Station returned HTTP " +
                            response.statusCode
                        )
                    );

                    return;
                }


                const metaInt =
                    parseInt(
                        response.headers[
                            "icy-metaint"
                        ]
                    );


                if (!metaInt || metaInt <= 0) {

                    response.destroy();

                    failure(
                        new Error(
                            "No ICY metadata interval"
                        )
                    );

                    return;
                }


                let audioBytes = 0;

                let metadataLength = null;

                let metadata =
                    Buffer.alloc(0);


                response.on(
                    "data",
                    chunk => {

                        let offset = 0;


                        while (
                            offset < chunk.length
                        ) {

                            // --------------------------------
                            // SKIP AUDIO
                            // --------------------------------

                            if (
                                audioBytes < metaInt
                            ) {

                                const remaining =
                                    metaInt -
                                    audioBytes;

                                const amount =
                                    Math.min(
                                        remaining,
                                        chunk.length -
                                        offset
                                    );

                                audioBytes += amount;

                                offset += amount;

                                continue;
                            }


                            // --------------------------------
                            // METADATA SIZE BYTE
                            // --------------------------------

                            if (
                                metadataLength === null
                            ) {

                                metadataLength =
                                    chunk[offset] * 16;

                                offset++;


                                if (
                                    metadataLength === 0
                                ) {

                                    audioBytes = 0;

                                    metadataLength = null;

                                    metadata =
                                        Buffer.alloc(0);

                                    continue;
                                }
                            }


                            // --------------------------------
                            // READ METADATA
                            // --------------------------------

                            const needed =
                                metadataLength -
                                metadata.length;


                            const amount =
                                Math.min(
                                    needed,
                                    chunk.length -
                                    offset
                                );


                            metadata =
                                Buffer.concat([
                                    metadata,
                                    chunk.subarray(
                                        offset,
                                        offset + amount
                                    )
                                ]);


                            offset += amount;


                            // --------------------------------
                            // COMPLETE BLOCK
                            // --------------------------------

                            if (
                                metadata.length >=
                                metadataLength
                            ) {

                                const text =
                                    metadata
                                    .toString("utf8")
                                    .replace(/\0/g, "");


                                const match =
                                    text.match(
                                        /StreamTitle=['"]([^'"]*)['"]/i
                                    );


                                if (
                                    match &&
                                    match[1] &&
                                    match[1].trim()
                                ) {

                                    response.destroy();

                                    success(
                                        cleanTitle(
                                            match[1]
                                        )
                                    );

                                    return;
                                }


                                audioBytes = 0;

                                metadataLength = null;

                                metadata =
                                    Buffer.alloc(0);
                            }
                        }
                    }
                );


                response.on(
                    "error",
                    failure
                );


                response.on(
                    "end",
                    () => {

                        failure(
                            new Error(
                                "Stream ended before metadata"
                            )
                        );
                    }
                );
            });


        request.on(
            "error",
            failure
        );


        request.setTimeout(
            12000,
            () => {

                request.destroy();

                failure(
                    new Error(
                        "Radio connection timed out"
                    )
                );
            }
        );


        request.end();
    });
}


// ======================================================
// GET RADIO SERVER BASE
// ======================================================

function getRadioBase(streamUrl) {

    try {

        const url =
            new URL(streamUrl);


        return (
            url.protocol +
            "//" +
            url.host
        );
    }

    catch (error) {

        return null;
    }
}


// ======================================================
// FIND TITLE IN JSON
// ======================================================

function findTitleInObject(obj) {

    if (!obj)
        return null;


    if (Array.isArray(obj)) {

        for (const item of obj) {

            const found =
                findTitleInObject(item);

            if (found)
                return found;
        }

        return null;
    }


    if (
        typeof obj !== "object"
    ) {
        return null;
    }


    if (
        obj.artist &&
        obj.title &&
        typeof obj.artist !== "object" &&
        typeof obj.title !== "object"
    ) {

        const artist =
            cleanTitle(obj.artist);

        const song =
            cleanTitle(obj.title);


        if (artist && song) {

            return (
                artist +
                " - " +
                song
            );
        }
    }


    const fields = [

        "songtitle",
        "songTitle",

        "streamtitle",
        "streamTitle",

        "StreamTitle",

        "current_song",
        "currentSong",

        "now_playing",
        "nowPlaying"
    ];


    for (const field of fields) {

        if (
            Object.prototype
                .hasOwnProperty
                .call(obj, field)
        ) {

            const value =
                obj[field];


            if (
                value &&
                typeof value === "object"
            ) {

                const nested =
                    findTitleInObject(
                        value
                    );

                if (nested)
                    return nested;
            }

            else {

                const title =
                    cleanTitle(value);

                if (title)
                    return title;
            }
        }
    }


    if (
        obj.title &&
        typeof obj.title !== "object"
    ) {

        const title =
            cleanTitle(obj.title);

        if (title)
            return title;
    }


    for (
        const key of Object.keys(obj)
    ) {

        const value =
            obj[key];


        if (
            value &&
            typeof value === "object"
        ) {

            const found =
                findTitleInObject(
                    value
                );

            if (found)
                return found;
        }
    }


    return null;
}


// ======================================================
// SHOUTCAST INDEX.HTML PLAYING NOW
// ======================================================

async function tryShoutcastIndex(baseURL) {

    try {

        const url =
            baseURL +
            "/index.html?sid=1";


        const html =
            await fetchText(url);


        if (!html)
            return null;


        const normalized =
            html
            .replace(/\r/g, " ")
            .replace(/\n/g, " ")
            .replace(/\t/g, " ");


        let match =
            normalized.match(
                /Playing\s*Now\s*:\s*(?:<\/?[^>]+>\s*)*([^<]+)/i
            );


        if (
            match &&
            match[1]
        ) {

            const title =
                cleanTitle(
                    stripHTML(
                        match[1]
                    )
                );


            if (title) {

                console.log(
                    "SHOUTCAST PLAYING NOW:",
                    title
                );

                return title;
            }
        }


        const plain =
            stripHTML(html);


        if (plain) {

            match =
                plain.match(
                    /Playing\s*Now\s*:\s*(.+?)(?=\s+(?:Stream|Listener|Avg\.|Server|Current|$))/i
                );


            if (
                match &&
                match[1]
            ) {

                const title =
                    cleanTitle(
                        match[1]
                    );


                if (title) {

                    console.log(
                        "SHOUTCAST PLAYING NOW:",
                        title
                    );

                    return title;
                }
            }
        }

    }

    catch (error) {

        console.log(
            "Shoutcast index lookup failed:",
            error.message
        );
    }


    return null;
}


// ======================================================
// OLD SHOUTCAST /7.HTML
// ======================================================

async function tryShoutcast7HTML(baseURL) {

    try {

        const text =
            await fetchText(
                baseURL +
                "/7.html"
            );


        if (!text)
            return null;


        const stripped =
            stripHTML(text);


        if (!stripped)
            return null;


        const parts =
            stripped.split(",");


        if (
            parts.length >= 7
        ) {

            const title =
                cleanTitle(
                    parts
                        .slice(6)
                        .join(",")
                );


            if (title) {

                console.log(
                    "SHOUTCAST 7.HTML:",
                    title
                );

                return title;
            }
        }

    }

    catch (error) {

        // Keep trying.
    }


    return null;
}


// ======================================================
// PLAIN CURRENT SONG ENDPOINT
// ======================================================

async function tryCurrentSong(baseURL) {

    const endpoints = [

        "/currentsong?sid=1",

        "/currentsong?sid=1&json=1"
    ];


    for (
        const endpoint of endpoints
    ) {

        try {

            const text =
                await fetchText(
                    baseURL +
                    endpoint
                );


            if (!text)
                continue;


            try {

                const json =
                    JSON.parse(text);


                const found =
                    findTitleInObject(
                        json
                    );


                if (found)
                    return found;
            }

            catch (error) {

                // Not JSON.
            }


            const title =
                cleanTitle(
                    stripHTML(text)
                );


            if (
                title &&
                title.length < 500
            ) {

                console.log(
                    "CURRENTSONG:",
                    title
                );

                return title;
            }

        }

        catch (error) {

            // Continue.
        }
    }


    return null;
}


// ======================================================
// ICECAST STATUS JSON
// ======================================================

async function tryIcecastJSON(baseURL) {

    try {

        const text =
            await fetchText(
                baseURL +
                "/status-json.xsl"
            );


        if (!text)
            return null;


        const json =
            JSON.parse(text);


        const title =
            findTitleInObject(
                json
            );


        if (title) {

            console.log(
                "ICECAST TITLE:",
                title
            );

            return title;
        }

    }

    catch (error) {

        // Continue.
    }


    return null;
}


// ======================================================
// SHOUTCAST STATS JSON
// ======================================================

async function tryShoutcastStats(baseURL) {

    const endpoints = [

        "/stats?sid=1&json=1",

        "/stats?sid=1"
    ];


    for (
        const endpoint of endpoints
    ) {

        try {

            const text =
                await fetchText(
                    baseURL +
                    endpoint
                );


            if (!text)
                continue;


            try {

                const json =
                    JSON.parse(text);


                const title =
                    findTitleInObject(
                        json
                    );


                if (title) {

                    console.log(
                        "SHOUTCAST STATS:",
                        title
                    );

                    return title;
                }
            }

            catch (error) {

                // Not JSON.
            }

        }

        catch (error) {

            // Continue.
        }
    }


    return null;
}


// ======================================================
// MASTER SONG LOOKUP
// ======================================================

async function getStreamTitle(streamUrl) {

    console.log(
        "Checking metadata for:",
        streamUrl
    );


    // 1. STANDARD ICY

    try {

        const title =
            await getIcyStreamTitle(
                streamUrl
            );


        if (title) {

            console.log(
                "ICY TITLE:",
                title
            );

            return title;
        }

    }

    catch (error) {

        console.log(
            "ICY lookup failed:",
            error.message
        );
    }


    const base =
        getRadioBase(
            streamUrl
        );


    if (!base) {

        throw new Error(
            "Unable to determine radio server"
        );
    }


    // 2. SHOUTCAST PLAYING NOW PAGE

    let title =
        await tryShoutcastIndex(
            base
        );


    if (title)
        return title;


    // 3. SHOUTCAST CURRENTSONG

    title =
        await tryCurrentSong(
            base
        );


    if (title)
        return title;


    // 4. SHOUTCAST STATS

    title =
        await tryShoutcastStats(
            base
        );


    if (title)
        return title;


    // 5. ICECAST STATUS

    title =
        await tryIcecastJSON(
            base
        );


    if (title)
        return title;


    // 6. OLD SHOUTCAST 7.HTML

    title =
        await tryShoutcast7HTML(
            base
        );


    if (title)
        return title;


    throw new Error(
        "No song metadata found for this station"
    );
}


// ======================================================
// UPDATE NOW PLAYING
// ======================================================

async function updateNowPlaying() {

    if (checking)
        return;


    checking = true;


    const streamBeingChecked =
        currentStream;


    try {

        const title =
            await getStreamTitle(
                streamBeingChecked
            );


        if (
            streamBeingChecked !==
            currentStream
        ) {

            console.log(
                "Ignoring metadata from previous station."
            );

            return;
        }


        const cleaned =
            cleanTitle(title);


        if (cleaned) {

            if (
                cleaned !==
                currentTitle
            ) {

                currentTitle =
                    cleaned;

                // Clear lyrics cache when song changes
                lyricsCache.title = null;
                lyricsCache.result = null;
                lyricsCache.updated = 0;


                console.log(
                    "NOW PLAYING:",
                    currentTitle
                );
            }
        }

    }

    catch (error) {

        console.log(
            "Metadata error:",
            error.message
        );


        if (
            currentTitle ===
            "Connecting to new station..."
        ) {

            currentTitle =
                "Waiting for song information...";
        }
    }

    finally {

        checking = false;
    }
}


// ======================================================
// SPLIT ARTIST + SONG
// ======================================================

function splitArtistAndSong(fullTitle) {

    if (!fullTitle) {

        return {
            artist: null,
            song: null
        };
    }


    const separator =
        fullTitle.indexOf(" - ");


    if (separator === -1) {

        return {
            artist: null,
            song: fullTitle.trim()
        };
    }


    return {

        artist:
            fullTitle
                .substring(
                    0,
                    separator
                )
                .trim(),

        song:
            fullTitle
                .substring(
                    separator + 3
                )
                .trim()
    };
}


// ======================================================
// CLEAN SONG NAME FOR LYRICS SEARCH
// ======================================================

function cleanSongForLyrics(value) {

    if (!value)
        return null;


    let song =
        String(value);


    // Remove common radio additions that can hurt matching
    song = song
        .replace(
            /\s*\[(?:official|audio|video|lyrics).*?\]\s*/gi,
            " "
        )
        .replace(
            /\s*\((?:official|audio|video|lyrics).*?\)\s*/gi,
            " "
        )
        .replace(
            /\s+/g,
            " "
        )
        .trim();


    return song || null;
}


// ======================================================
// LRCLIB SEARCH
// ======================================================

async function searchLRCLIB(
    artist,
    song
) {

    if (!song)
        return null;


    const cleanArtist =
        artist
            ? artist.trim()
            : "";

    const cleanSong =
        cleanSongForLyrics(song);


    let query =
        cleanSong;


    if (cleanArtist) {

        query =
            cleanArtist +
            " " +
            cleanSong;
    }


    const searchURL =
        "https://lrclib.net/api/search?q=" +
        encodeURIComponent(query);


    console.log(
        "LRCLIB SEARCH:",
        query
    );


    const text =
        await fetchText(
            searchURL,
            10000
        );


    let results;


    try {

        results =
            JSON.parse(text);
    }

    catch (error) {

        throw new Error(
            "LRCLIB returned invalid JSON"
        );
    }


    if (
        !Array.isArray(results) ||
        results.length === 0
    ) {

        console.log(
            "LRCLIB: No results"
        );

        return null;
    }


    // --------------------------------------------------
    // Find the best result.
    // Prefer exact artist/title matches.
    // Then prefer synchronized lyrics.
    // --------------------------------------------------

    const normalize =
        value => String(value || "")
            .toLowerCase()
            .replace(/[^\p{L}\p{N}]+/gu, " ")
            .replace(/\s+/g, " ")
            .trim();


    const wantedArtist =
        normalize(cleanArtist);

    const wantedSong =
        normalize(cleanSong);


    let best = null;
    let bestScore = -1;


    for (const item of results) {

        if (!item)
            continue;


        let score = 0;


        const resultArtist =
            normalize(
                item.artistName
            );

        const resultSong =
            normalize(
                item.trackName
            );


        if (
            wantedSong &&
            resultSong === wantedSong
        ) {

            score += 100;
        }

        else if (
            wantedSong &&
            (
                resultSong.includes(
                    wantedSong
                ) ||
                wantedSong.includes(
                    resultSong
                )
            )
        ) {

            score += 50;
        }


        if (
            wantedArtist &&
            resultArtist === wantedArtist
        ) {

            score += 100;
        }

        else if (
            wantedArtist &&
            (
                resultArtist.includes(
                    wantedArtist
                ) ||
                wantedArtist.includes(
                    resultArtist
                )
            )
        ) {

            score += 40;
        }


        if (
            item.syncedLyrics &&
            item.syncedLyrics.trim()
        ) {

            score += 25;
        }


        if (
            item.plainLyrics &&
            item.plainLyrics.trim()
        ) {

            score += 10;
        }


        if (
            item.instrumental === true
        ) {

            score -= 100;
        }


        if (score > bestScore) {

            bestScore = score;
            best = item;
        }
    }


    if (!best)
        return null;


    console.log(
        "LRCLIB MATCH:",
        best.artistName,
        "-",
        best.trackName
    );


    return best;
}


// ======================================================
// GET LYRICS FOR CURRENT SONG
// ======================================================

async function getCurrentLyrics() {

    const title =
        currentTitle;


    if (
        !title ||
        title ===
            "Connecting to Slow Tide..." ||
        title ===
            "Connecting to new station..." ||
        title ===
            "Waiting for song information..."
    ) {

        return {

            success: false,

            status:
                "waiting",

            title:
                title,

            message:
                "Waiting for song information."
        };
    }


    // Use cache if same song
    if (
        lyricsCache.title === title &&
        lyricsCache.result
    ) {

        return lyricsCache.result;
    }


    const info =
        splitArtistAndSong(
            title
        );


    if (!info.song) {

        return {

            success: false,

            status:
                "unavailable",

            artist:
                info.artist,

            song:
                info.song,

            message:
                "Unable to determine song title."
        };
    }


    try {

        const match =
            await searchLRCLIB(
                info.artist,
                info.song
            );


        if (!match) {

            const unavailable = {

                success: false,

                status:
                    "unavailable",

                artist:
                    info.artist,

                song:
                    info.song,

                title:
                    title,

                message:
                    "Lyrics unavailable for this track.",

                source:
                    "LRCLIB"
            };


            lyricsCache = {

                title:
                    title,

                result:
                    unavailable,

                updated:
                    Date.now()
            };


            return unavailable;
        }


        const hasSynced =
            Boolean(
                match.syncedLyrics &&
                match.syncedLyrics.trim()
            );


        const hasPlain =
            Boolean(
                match.plainLyrics &&
                match.plainLyrics.trim()
            );


        const result = {

            success:
                hasSynced ||
                hasPlain,

            status:
                hasSynced
                    ? "synced"
                    : (
                        hasPlain
                            ? "plain"
                            : "unavailable"
                    ),

            artist:
                info.artist,

            song:
                info.song,

            title:
                title,

            matchedArtist:
                match.artistName ||
                null,

            matchedSong:
                match.trackName ||
                null,

            album:
                match.albumName ||
                null,

            duration:
                match.duration ||
                null,

            instrumental:
                Boolean(
                    match.instrumental
                ),

            syncedLyrics:
                hasSynced
                    ? match.syncedLyrics
                    : null,

            plainLyrics:
                hasPlain
                    ? match.plainLyrics
                    : null,

            source:
                "LRCLIB",

            updated:
                new Date().toISOString()
        };


        if (
            !hasSynced &&
            !hasPlain
        ) {

            result.message =
                match.instrumental
                    ? "Instrumental track."
                    : "Lyrics unavailable for this track.";
        }


        lyricsCache = {

            title:
                title,

            result:
                result,

            updated:
                Date.now()
        };


        return result;
    }

    catch (error) {

        console.log(
            "LRCLIB ERROR:",
            error.message
        );


        return {

            success: false,

            status:
                "error",

            artist:
                info.artist,

            song:
                info.song,

            title:
                title,

            message:
                "Lyrics service temporarily unavailable.",

            source:
                "LRCLIB"
        };
    }
}


// ======================================================
// STATUS API
// ======================================================

app.get(
    "/api/status",
    (req, res) => {

        res.set(
            "Cache-Control",
            "no-store"
        );


        res.json({

            online: true,

            service:
                "Slow Tide Now Playing",

            stream:
                currentStream,

            title:
                currentTitle
        });
    }
);


// ======================================================
// NOW PLAYING API
// ======================================================

app.get(
    "/api/now-playing",
    (req, res) => {

        res.set(
            "Cache-Control",
            "no-store, no-cache, must-revalidate"
        );


        res.json({

            title:
                currentTitle,

            stream:
                currentStream,

            updated:
                new Date().toISOString()
        });
    }
);


// ======================================================
// LYRICS API
// ======================================================

app.get(
    "/api/lyrics",
    async (req, res) => {

        res.set(
            "Cache-Control",
            "no-store, no-cache, must-revalidate"
        );


        try {

            const lyrics =
                await getCurrentLyrics();


            res.json(
                lyrics
            );
        }

        catch (error) {

            console.log(
                "Lyrics API error:",
                error.message
            );


            res.status(500).json({

                success: false,

                status:
                    "error",

                message:
                    "Unable to retrieve lyrics."
            });
        }
    }
);


// ======================================================
// CHANGE ACTIVE RADIO
// Called by Second Life controller
// ======================================================

app.post(
    "/api/set-stream",
    async (req, res) => {

        let stream =
            req.body &&
            req.body.stream;


        if (
            !stream ||
            typeof stream !== "string"
        ) {

            return res
                .status(400)
                .json({

                    success: false,

                    error:
                        "Missing stream URL"
                });
        }


        stream =
            stream.trim();


        try {

            const parsed =
                new URL(stream);


            if (
                parsed.protocol !== "http:" &&
                parsed.protocol !== "https:"
            ) {

                throw new Error(
                    "Unsupported protocol"
                );
            }

        }

        catch (error) {

            return res
                .status(400)
                .json({

                    success: false,

                    error:
                        "Invalid radio stream URL"
                });
        }


        const changed =
            stream !==
            currentStream;


        currentStream =
            stream;


        if (changed) {

            currentTitle =
                "Connecting to new station...";


            // Clear old lyrics
            lyricsCache.title = null;
            lyricsCache.result = null;
            lyricsCache.updated = 0;


            console.log(
                "================================"
            );

            console.log(
                "SLOW TIDE RADIO CHANGED"
            );

            console.log(
                "NEW STREAM:",
                currentStream
            );

            console.log(
                "================================"
            );
        }


        res.status(200).json({

            success: true,

            message:
                "Slow Tide radio updated",

            stream:
                currentStream
        });


        setTimeout(
            updateNowPlaying,
            500
        );
    }
);


// ======================================================
// MANUAL REFRESH / TEST
// ======================================================

app.get(
    "/api/refresh",
    async (req, res) => {

        await updateNowPlaying();


        res.set(
            "Cache-Control",
            "no-store"
        );


        res.json({

            success: true,

            stream:
                currentStream,

            title:
                currentTitle
        });
    }
);


// ======================================================
// START SERVER
// ======================================================

app.listen(
    PORT,
    () => {

        console.log(
            "================================"
        );

        console.log(
            "SLOW TIDE NOW PLAYING"
        );

        console.log(
            "Server running on port:",
            PORT
        );

        console.log(
            "Starting station:",
            currentStream
        );

        console.log(
            "Lyrics TV: /lyrics"
        );

        console.log(
            "Lyrics API: /api/lyrics"
        );

        console.log(
            "================================"
        );


        setTimeout(
            updateNowPlaying,
            1000
        );


        setInterval(
            updateNowPlaying,
            10000
        );
    }
);
