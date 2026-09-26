const express = require("express");
const http = require("http");
const https = require("https");

const app = express();

app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;


// ======================================================
// SLOW TIDE NOW PLAYING SERVER
// Da Obsidian Court
// ======================================================


// ======================================================
// DEFAULT STATION
// ======================================================

let currentStream =
    "http://mogullustradio.shoutcastnet.com:30800/stream";

let currentTitle =
    "Connecting to Slow Tide...";

let checking = false;


// ======================================================
// BASIC HTTP REQUEST
// Used for JSON / status-page fallbacks
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
        catch (err) {
            reject(err);
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
                "User-Agent": "Mozilla/5.0 SlowTideNowPlaying",
                "Accept": "*/*",
                "Connection": "close"
            }
        };

        const request =
            client.request(options, response => {

                // Follow redirects
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

                let data = "";

                response.setEncoding("utf8");

                response.on("data", chunk => {

                    data += chunk;

                    // Status responses should be tiny.
                    if (data.length > 1000000) {
                        response.destroy();
                    }
                });

                response.on("end", () => {
                    resolve(data);
                });

                response.on("error", reject);
            });

        request.on("error", reject);

        request.setTimeout(timeout, () => {

            request.destroy();

            reject(
                new Error(
                    "Request timed out"
                )
            );
        });

        request.end();
    });
}


// ======================================================
// READ STANDARD ICY / SHOUTCAST / ICECAST METADATA
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

                "icy-metadata": "1",

                "User-Agent":
                    "Mozilla/5.0 SlowTideNowPlaying",

                "Accept":
                    "*/*",

                "Connection":
                    "close"
            }
        };

        let settled = false;

        const finishResolve = value => {

            if (settled)
                return;

            settled = true;

            resolve(value);
        };

        const finishReject = error => {

            if (settled)
                return;

            settled = true;

            reject(error);
        };


        const request =
            client.request(
                options,
                response => {

                    // ------------------------------------------
                    // FOLLOW REDIRECT
                    // ------------------------------------------

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
                        .then(finishResolve)
                        .catch(finishReject);

                        return;
                    }


                    // ------------------------------------------
                    // BAD RESPONSE
                    // ------------------------------------------

                    if (
                        response.statusCode &&
                        response.statusCode >= 400
                    ) {

                        response.destroy();

                        finishReject(
                            new Error(
                                "Station returned HTTP " +
                                response.statusCode
                            )
                        );

                        return;
                    }


                    // ------------------------------------------
                    // ICY META INTERVAL
                    // ------------------------------------------

                    const rawMetaInt =
                        response.headers["icy-metaint"];

                    const metaInt =
                        parseInt(rawMetaInt);


                    console.log(
                        "ICY METAINT:",
                        rawMetaInt || "NOT PROVIDED"
                    );


                    if (!metaInt || metaInt <= 0) {

                        response.destroy();

                        finishReject(
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

                                // ----------------------------------
                                // AUDIO DATA
                                // ----------------------------------

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

                                    audioBytes +=
                                        amount;

                                    offset +=
                                        amount;

                                    continue;
                                }


                                // ----------------------------------
                                // METADATA LENGTH BYTE
                                // ----------------------------------

                                if (
                                    metadataLength ===
                                    null
                                ) {

                                    metadataLength =
                                        chunk[offset] * 16;

                                    offset++;


                                    if (
                                        metadataLength === 0
                                    ) {

                                        audioBytes = 0;

                                        metadataLength =
                                            null;

                                        metadata =
                                            Buffer.alloc(0);

                                        continue;
                                    }
                                }


                                // ----------------------------------
                                // READ METADATA
                                // ----------------------------------

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


                                // ----------------------------------
                                // COMPLETE METADATA BLOCK
                                // ----------------------------------

                                if (
                                    metadata.length >=
                                    metadataLength
                                ) {

                                    const text =
                                        metadata
                                        .toString("utf8")
                                        .replace(/\0/g, "")
                                        .trim();


                                    console.log(
                                        "ICY RAW:",
                                        text
                                    );


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

                                        finishResolve(
                                            match[1].trim()
                                        );

                                        return;
                                    }


                                    // No title in this metadata block.
                                    // Continue until the next one.

                                    audioBytes = 0;

                                    metadataLength =
                                        null;

                                    metadata =
                                        Buffer.alloc(0);
                                }
                            }
                        }
                    );


                    response.on(
                        "error",
                        finishReject
                    );


                    response.on(
                        "end",
                        () => {

                            finishReject(
                                new Error(
                                    "Stream ended before metadata was found"
                                )
                            );
                        }
                    );
                }
            );


        request.on(
            "error",
            finishReject
        );


        request.setTimeout(
            12000,
            () => {

                request.destroy();

                finishReject(
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
// CLEAN TITLE
// ======================================================

function cleanTitle(value) {

    if (
        value === undefined ||
        value === null
    ) {
        return null;
    }

    let title =
        String(value)
        .replace(/\0/g, "")
        .replace(/&amp;/gi, "&")
        .replace(/&#39;/gi, "'")
        .replace(/&quot;/gi, "\"")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .trim();


    if (!title)
        return null;


    const lower =
        title.toLowerCase();


    // Reject values that obviously aren't song titles.

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
// SEARCH OBJECT RECURSIVELY FOR SONG TITLE
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


    // ------------------------------------------
    // COMMON SHOUTCAST / ICECAST FIELDS
    // ------------------------------------------

    const directFields = [

        "songtitle",
        "songTitle",

        "streamtitle",
        "streamTitle",

        "StreamTitle",

        "current_song",
        "currentSong",

        "now_playing",
        "nowPlaying",

        "title"
    ];


    for (
        const field of directFields
    ) {

        if (
            Object.prototype
            .hasOwnProperty
            .call(obj, field)
        ) {

            const value =
                obj[field];


            // Some APIs use:
            //
            // now_playing:
            // {
            //    song: {
            //       artist: "...",
            //       title: "..."
            //    }
            // }

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

                const cleaned =
                    cleanTitle(value);

                if (cleaned)
                    return cleaned;
            }
        }
    }


    // ------------------------------------------
    // ARTIST + TITLE
    // ------------------------------------------

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


    // ------------------------------------------
    // RECURSIVE SEARCH
    // ------------------------------------------

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
// TRY JSON STATUS URL
// ======================================================

async function tryJsonURL(url) {

    try {

        const text =
            await fetchText(url);


        if (!text)
            return null;


        const json =
            JSON.parse(text);


        const title =
            findTitleInObject(json);


        if (title) {

            console.log(
                "STATUS API TITLE:",
                title
            );

            return title;
        }

    }

    catch (error) {

        // Quiet fallback.
    }


    return null;
}


// ======================================================
// SHOUTCAST 7.HTML FALLBACK
// ======================================================

async function tryShoutcast7HTML(baseURL) {

    try {

        const text =
            await fetchText(
                baseURL + "/7.html"
            );


        if (!text)
            return null;


        // Old Shoutcast format commonly resembles:
        //
        // <body>listeners,status,peak,max,unique,bitrate,Song Title</body>


        const stripped =
            text
            .replace(/<[^>]*>/g, "")
            .trim();


        const parts =
            stripped.split(",");


        if (parts.length >= 7) {

            const title =
                cleanTitle(
                    parts.slice(6).join(",")
                );


            if (title) {

                console.log(
                    "SHOUTCAST 7.HTML TITLE:",
                    title
                );

                return title;
            }
        }

    }

    catch (error) {

        // Quiet fallback.
    }


    return null;
}


// ======================================================
// STATUS PAGE FALLBACK
// ======================================================

async function tryStatusPage(baseURL) {

    const pages = [

        "/status-json.xsl",

        "/stats?sid=1&json=1",

        "/stats?sid=1",

        "/currentsong?sid=1",

        "/7.html"
    ];


    for (
        const path of pages
    ) {

        const url =
            baseURL + path;


        // ------------------------------------------
        // OLD SHOUTCAST
        // ------------------------------------------

        if (
            path === "/7.html"
        ) {

            const title =
                await tryShoutcast7HTML(
                    baseURL
                );

            if (title)
                return title;

            continue;
        }


        // ------------------------------------------
        // JSON
        // ------------------------------------------

        try {

            const text =
                await fetchText(url);


            if (!text)
                continue;


            // Try JSON first.

            try {

                const json =
                    JSON.parse(text);

                const title =
                    findTitleInObject(
                        json
                    );

                if (title) {

                    console.log(
                        "FALLBACK TITLE:",
                        title
                    );

                    return title;
                }

            }

            catch (jsonError) {

                // Not JSON.
            }


            // --------------------------------------
            // PLAIN TEXT CURRENT SONG
            // --------------------------------------

            if (
                path.includes(
                    "currentsong"
                )
            ) {

                const plain =
                    cleanTitle(
                        text.replace(
                            /<[^>]*>/g,
                            ""
                        )
                    );


                if (
                    plain &&
                    plain.length < 500
                ) {

                    console.log(
                        "CURRENTSONG TITLE:",
                        plain
                    );

                    return plain;
                }
            }

        }

        catch (error) {

            // Keep trying.
        }
    }


    return null;
}


// ======================================================
// GET BASE RADIO SERVER
//
// Example:
// http://station.com:8000/stream
//
// becomes:
//
// http://station.com:8000
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
// MASTER METADATA LOOKUP
// ======================================================

async function getStreamTitle(streamUrl) {

    // ==================================================
    // METHOD 1
    // Standard ICY embedded metadata
    // ==================================================

    try {

        const title =
            await getIcyStreamTitle(
                streamUrl
            );


        if (title)
            return title;

    }

    catch (error) {

        console.log(
            "ICY lookup failed:",
            error.message
        );
    }


    // ==================================================
    // METHOD 2
    // Check radio server status APIs
    // ==================================================

    const base =
        getRadioBase(
            streamUrl
        );


    if (base) {

        const title =
            await tryStatusPage(
                base
            );


        if (title)
            return title;
    }


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


    // Remember which station we're checking.
    // This prevents an old request from overwriting
    // metadata after a DJ changes stations.

    const streamBeingChecked =
        currentStream;


    try {

        const title =
            await getStreamTitle(
                streamBeingChecked
            );


        // Station changed while we were checking.
        if (
            streamBeingChecked !==
            currentStream
        ) {

            console.log(
                "Station changed during metadata check. Ignoring old result."
            );

            return;
        }


        if (title) {

            const cleaned =
                cleanTitle(title);


            if (
                cleaned &&
                cleaned !==
                currentTitle
            ) {

                currentTitle =
                    cleaned;


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


        // Don't overwrite a good previous song
        // during a temporary station hiccup.

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
// SERVER STATUS
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
// Second Life media display reads this
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
// CHANGE RADIO API
// Second Life controller sends the new stream here
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


        // ----------------------------------------------
        // VALIDATE URL
        // ----------------------------------------------

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


        // ----------------------------------------------
        // CHANGE ACTIVE STATION
        // ----------------------------------------------

        const changed =
            stream !== currentStream;


        currentStream =
            stream;


        if (changed) {

            currentTitle =
                "Connecting to new station...";


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


        // ----------------------------------------------
        // RESPOND TO SECOND LIFE IMMEDIATELY
        // ----------------------------------------------

        res.status(200).json({

            success: true,

            message:
                "Slow Tide radio updated",

            stream:
                currentStream
        });


        // ----------------------------------------------
        // LOOK UP SONG AFTER RESPONSE
        // ----------------------------------------------

        setTimeout(
            () => {
                updateNowPlaying();
            },
            500
        );
    }
);


// ======================================================
// MANUAL REFRESH
// Useful for testing
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
            "================================"
        );


        // Initial metadata lookup

        setTimeout(
            updateNowPlaying,
            1000
        );


        // Keep following the currently selected station.

        setInterval(
            updateNowPlaying,
            10000
        );
    }
);
