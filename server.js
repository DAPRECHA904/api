const express = require("express");
const http = require("http");

const app = express();
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;

// Default station when server starts
let currentStream =
  "http://mogullustradio.shoutcastnet.com:30800/stream";

let currentTitle = "Connecting to Slow Tide...";


// --------------------------------------------------
// Read ICY / SHOUTCAST metadata
// --------------------------------------------------

function getStreamTitle(streamUrl) {

    return new Promise((resolve, reject) => {

        try {

            const url = new URL(streamUrl);

            const options = {
                hostname: url.hostname,
                port: url.port || 80,
                path: url.pathname + url.search,
                method: "GET",

                headers: {
                    "Icy-MetaData": "1",
                    "User-Agent": "SlowTideNowPlaying/1.0"
                }
            };


            const request = http.request(options, response => {

                const metaInt =
                    parseInt(response.headers["icy-metaint"]);

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
                let metadata = Buffer.alloc(0);


                response.on("data", chunk => {

                    let offset = 0;


                    while (offset < chunk.length) {

                        // Skip audio until metadata point
                        if (audioBytes < metaInt) {

                            const remaining =
                                metaInt - audioBytes;

                            const amount =
                                Math.min(
                                    remaining,
                                    chunk.length - offset
                                );

                            audioBytes += amount;
                            offset += amount;

                            continue;
                        }


                        // Read metadata length byte
                        if (metadataLength === null) {

                            metadataLength =
                                chunk[offset] * 16;

                            offset++;


                            if (metadataLength === 0) {

                                audioBytes = 0;
                                metadataLength = null;

                                continue;
                            }
                        }


                        const needed =
                            metadataLength -
                            metadata.length;

                        const amount =
                            Math.min(
                                needed,
                                chunk.length - offset
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


                        // Complete metadata block
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
                                    /StreamTitle='([^']*)'/
                                );


                            response.destroy();


                            if (
                                match &&
                                match[1]
                            ) {

                                resolve(
                                    match[1].trim()
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
                });


                response.on("error", reject);

            });


            request.on("error", reject);

            request.setTimeout(
                10000,
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


// --------------------------------------------------
// Poll current radio
// --------------------------------------------------

async function updateNowPlaying() {

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
            "Metadata:",
            error.message
        );
    }
}


// --------------------------------------------------
// API used by webpage
// --------------------------------------------------

app.get(
    "/api/now-playing",
    (req, res) => {

        res.json({
            title: currentTitle,
            stream: currentStream
        });
    }
);


// --------------------------------------------------
// API used by SECOND LIFE PRIM
// --------------------------------------------------

app.post(
    "/api/set-stream",
    (req, res) => {

        const stream =
            req.body.stream;


        if (
            !stream ||
            typeof stream !== "string"
        ) {

            return res
                .status(400)
                .json({
                    error:
                        "Missing stream URL"
                });
        }


        if (
            !stream.startsWith("http://") &&
            !stream.startsWith("https://")
        ) {

            return res
                .status(400)
                .json({
                    error:
                        "Invalid stream URL"
                });
        }


        if (
            stream !== currentStream
        ) {

            console.log(
                "PARCEL RADIO CHANGED:"
            );

            console.log(stream);


            currentStream = stream;

            currentTitle =
                "Connecting to new station...";


            // Check new station immediately
            updateNowPlaying();
        }


        res.json({
            success: true,
            stream: currentStream
        });
    }
);


// --------------------------------------------------
// Start server
// --------------------------------------------------

app.listen(
    PORT,
    () => {

        console.log(
            "Slow Tide Now Playing running on port",
            PORT
        );


        // Check immediately
        updateNowPlaying();


        // Check song every 10 seconds
        setInterval(
            updateNowPlaying,
            10000
        );
    }
);
