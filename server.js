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

// Default radio station
let currentStream =
    "http://mogullustradio.shoutcastnet.com:30800/stream";

let currentTitle =
    "Connecting to Slow Tide...";


// ======================================================
// READ SHOUTCAST / ICECAST METADATA
// ======================================================

function getStreamTitle(streamUrl, redirects = 0) {

    return new Promise((resolve, reject) => {

        if (redirects > 5) {
            reject(new Error("Too many redirects."));
            return;
        }

        try {

            const url = new URL(streamUrl);

            const client =
                url.protocol === "https:"
                    ? https
                    : http;


            const options = {

                hostname: url.hostname,

                port:
                    url.port ||
                    (url.protocol === "https:"
                        ? 443
                        : 80),

                path:
                    url.pathname +
                    url.search,

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


            const request =
                client.request(
                    options,
                    response => {

                        // ------------------------------
                        // FOLLOW REDIRECTS
                        // ------------------------------

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

                            getStreamTitle(
                                redirectURL,
                                redirects + 1
                            )
                            .then(resolve)
                            .catch(reject);

                            return;
                        }


                        // ------------------------------
                        // CHECK RESPONSE
                        // ------------------------------

                        if (
                            response.statusCode &&
                            response.statusCode >= 400
                        ) {

                            response.destroy();

                            reject(
                                new Error(
                                    "Station returned HTTP " +
                                    response.statusCode
                                )
                            );

                            return;
                        }


                        // ------------------------------
                        // ICY METADATA INTERVAL
                        // ------------------------------

                        const metaInt =
                            parseInt(
                                response.headers[
                                    "icy-metaint"
                                ]
                            );


                        if (!metaInt) {

                            response.destroy();

                            reject(
                                new Error(
                                    "Station does not provide ICY metadata."
                                )
                            );

                            return;
                        }


                        let audioBytes = 0;

                        let metadataLength = null;

                        let metadata =
                            Buffer.alloc(0);


                        // ------------------------------
                        // READ STREAM
                        // ------------------------------

                        response.on(
                            "data",
                            chunk => {

                                let offset = 0;


                                while (
                                    offset <
                                    chunk.length
                                ) {

                                    // Skip audio bytes
                                    if (
                                        audioBytes <
                                        metaInt
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


                                    // Metadata length byte
                                    if (
                                        metadataLength ===
                                        null
                                    ) {

                                        metadataLength =
                                            chunk[offset] *
                                            16;

                                        offset++;


                                        if (
                                            metadataLength ===
                                            0
                                        ) {

                                            audioBytes = 0;

                                            metadataLength =
                                                null;

                                            continue;
                                        }
                                    }


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
                                                offset +
                                                amount
                                            )
                                        ]);


                                    offset += amount;


                                    // ------------------
                                    // COMPLETE METADATA
                                    // ------------------

                                    if (
                                        metadata.length >=
                                        metadataLength
                                    ) {

                                        const text =
                                            metadata
                                            .toString(
                                                "utf8"
                                            )
                                            .replace(
                                                /\0/g,
                                                ""
                                            );


                                        const match =
                                            text.match(
                                                /StreamTitle='([^']*)'/
                                            );


                                        response.destroy();


                                        if (
                                            match &&
                                            match[1]
                                        ) {

                                            resolve(
                                                match[1]
                                                .trim()
                                            );

                                        } else {

                                            reject(
                                                new Error(
                                                    "No StreamTitle found."
                                                )
                                            );
                                        }

                                        return;
                                    }
                                }
                            }
                        );


                        response.on(
                            "error",
                            reject
                        );
                    }
                );


            request.on(
                "error",
                reject
            );


            // Don't allow dead stations
            // to hold the server forever.

            request.setTimeout(
                12000,
                () => {

                    request.destroy();

                    reject(
                        new Error(
                            "Radio connection timed out."
                        )
                    );
                }
            );


            request.end();

        }

        catch (error) {

            reject(error);
        }
    });
}


// ======================================================
// UPDATE NOW PLAYING
// ======================================================

let checking = false;


async function updateNowPlaying() {

    // Prevent overlapping stream checks
    if (checking)
        return;


    checking = true;


    try {

        const title =
            await getStreamTitle(
                currentStream
            );


        if (
            title &&
            title !== currentTitle
        ) {

            currentTitle = title;


            console.log(
                "NOW PLAYING:",
                currentTitle
            );
        }

    }

    catch (error) {

        console.log(
            "Metadata error:",
            error.message
        );
    }

    finally {

        checking = false;
    }
}


// ======================================================
// TEST PAGE
// ======================================================

app.get(
    "/api/status",
    (req, res) => {

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
// Used by your Second Life media screen
// ======================================================

app.get(
    "/api/now-playing",
    (req, res) => {

        res.set(
            "Cache-Control",
            "no-store"
        );


        res.json({

            title:
                currentTitle,

            stream:
                currentStream
        });
    }
);


// ======================================================
// CHANGE RADIO API
// Used by your Second Life radio controller
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


        // Validate URL
        try {

            const parsed =
                new URL(stream);


            if (
                parsed.protocol !== "http:" &&
                parsed.protocol !== "https:"
            ) {

                throw new Error();
            }

        }

        catch {

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
                currentStream
            );

            console.log(
                "================================"
            );


            // Start metadata lookup
            // Don't make Second Life wait for it.

            updateNowPlaying();
        }


        // Immediately tell Second Life it worked.

        return res.status(200).json({

            success: true,

            message:
                "Slow Tide radio updated",

            stream:
                currentStream
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
            "Slow Tide Now Playing"
        );

        console.log(
            "Server running on port",
            PORT
        );

        console.log(
            "Starting station:",
            currentStream
        );

        console.log(
            "================================"
        );


        // Get current song immediately
        updateNowPlaying();


        // Check every 10 seconds
        setInterval(
            updateNowPlaying,
            10000
        );
    }
);
