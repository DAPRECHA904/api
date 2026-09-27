    const express = require("express");
    const http = require("http");
    const https = require("https");
    const path = require("path");

    const app = express();

    app.use(express.json());
    app.use(express.static(__dirname));

// ======================================================
// SLOW TIDE — MESSAGES IN THE CLOUDS
// ======================================================
app.get("/clouds", (req, res) => {
    res.sendFile(path.join(__dirname, "clouds.html"));
});

app.get("/clouds.html", (req, res) => {
    res.sendFile(path.join(__dirname, "clouds.html"));
});

// Individual physical cloud display — use ?slot=1 through ?slot=6
app.get("/cloud", (req, res) => {
    res.sendFile(path.join(__dirname, "cloud.html"));
});

app.get("/cloud.html", (req, res) => {
    res.sendFile(path.join(__dirname, "cloud.html"));
});



    // ======================================================
    // SLOW TIDE LYRICS TV
    // ======================================================

    app.get("/lyrics", (req, res) => {
        res.sendFile(path.join(__dirname, "lyrics.html"));
    });

    app.get("/lyrics.html", (req, res) => {
        res.sendFile(path.join(__dirname, "lyrics.html"));
    });

    // SLOW TIDE MUSIC VIDEO TV
    app.get("/video", (req, res) => {
        res.sendFile(path.join(__dirname, "video.html"));
    });
    app.get("/video.html", (req, res) => {
        res.sendFile(path.join(__dirname, "video.html"));
    });


    const PORT = process.env.PORT || 3000;


    // ======================================================
    // SLOW TIDE NOW PLAYING SERVER
    // ======================================================

    let currentStream =
        "http://mogullustradio.shoutcastnet.com:30800/stream";

    let currentTitle =
        "Connecting to Slow Tide...";

    let checking = false;

    // ======================================================
    // MASTER SONG SYNC CLOCK
    // ======================================================

    // Shared server clock used by every Slow Tide Lyrics TV.
    // This resets whenever the server detects a new song.
    let songStartedAt = Date.now();


    // ======================================================
    // LYRICS CACHE
    // ======================================================

    let lyricsCache = {
        title: null,
        result: null,
        updated: 0
    };

    // YOUTUBE MUSIC VIDEO
    const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

// KNOWN OFFICIAL MUSIC VIDEO OVERRIDES
// Keys are normalized "artist - song" strings. Add more known official videos here as needed.
const OFFICIAL_VIDEO_OVERRIDES = {
  "mk xyz - one time": "cLwnojWx0Ac"
};

function videoOverrideKey(artist, song) {
  return normalizeVideoText(`${artist || ""} - ${song || ""}`)
    .replace(/\b(feat|ft|featuring)\b.*$/i, "")
    .replace(/\bofficial\b|\bmusic video\b|\bvideo\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getOfficialVideoOverride(artist, song) {
  const exact = videoOverrideKey(artist, song);
  if (OFFICIAL_VIDEO_OVERRIDES[exact]) return OFFICIAL_VIDEO_OVERRIDES[exact];

  // Also tolerate punctuation/version cleanup differences.
  const wantedArtist = normalizeVideoText(artist);
  const wantedSong = normalizeVideoText(removeFeaturedArtists(removeVersionInfo(song)));
  for (const [key, videoId] of Object.entries(OFFICIAL_VIDEO_OVERRIDES)) {
    const normalizedKey = normalizeVideoText(key);
    if (normalizedKey.includes(wantedArtist) && normalizedKey.includes(wantedSong)) {
      return videoId;
    }
  }
  return null;
}

    let videoCache = {
        title: null,
        result: null,
        updated: 0
    };

    // YouTube search protection. If Google returns HTTP 429, pause new
    // API searches so the TVs cannot repeatedly hammer the daily quota.
    // Official video overrides still work because they are checked first.
    let youtubeSearchBackoffUntil = 0;
    const YOUTUBE_429_BACKOFF_MS = 6 * 60 * 60 * 1000;



    // ======================================================
    // CLOUD MESSAGE STATE + API — MULTI CLOUD VERSION
    // ======================================================

    const CLOUD_MESSAGE_LIFETIME_MS = 10 * 60 * 1000;
    const CLOUD_SUBMIT_COOLDOWN_MS = 15000;
    const CLOUD_MAX_ACTIVE = 6;
    const CLOUD_TO_MAX = 40;
    const CLOUD_FROM_MAX = 40;
    const CLOUD_MESSAGE_MAX = 180;

    let cloudMessages = [];
    let nextCloudMessageId = 1;
    const cloudLastSubmitByKey = new Map();

    function cleanCloudField(value, maxLength) {
        if (typeof value !== "string") return "";
        return value
            .replace(/[\u0000-\u001F\u007F]/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, maxLength);
    }

    function getCloudClientKey(req) {
        const senderKey = cleanCloudField(
            req.body && req.body.senderKey ? req.body.senderKey : "",
            80
        );
        if (senderKey) return "sl:" + senderKey.toLowerCase();

        const forwarded = String(req.headers["x-forwarded-for"] || "")
            .split(",")[0]
            .trim();

        return "ip:" + (forwarded || req.ip || "unknown");
    }

    function cleanupCloudMessages() {
        const now = Date.now();

        cloudMessages = cloudMessages.filter(item =>
            item &&
            item.createdAt &&
            (now - item.createdAt) <= CLOUD_MESSAGE_LIFETIME_MS
        );

        if (cloudMessages.length > CLOUD_MAX_ACTIVE) {
            cloudMessages = cloudMessages.slice(-CLOUD_MAX_ACTIVE);
        }
    }

    app.get("/api/cloud-message", (req, res) => {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate");
        cleanupCloudMessages();

        if (cloudMessages.length === 0) {
            return res.json({
                success: false,
                status: "idle",
                count: 0,
                maxActive: CLOUD_MAX_ACTIVE,
                lifetimeSeconds: Math.floor(CLOUD_MESSAGE_LIFETIME_MS / 1000),
                messages: [],
                message: "No active cloud messages."
            });
        }

        const messages = cloudMessages.map(item => ({
            ...item,
            expiresAt: item.createdAt + CLOUD_MESSAGE_LIFETIME_MS
        }));

        return res.json({
            success: true,
            status: "active",
            count: messages.length,
            maxActive: CLOUD_MAX_ACTIVE,
            lifetimeSeconds: Math.floor(CLOUD_MESSAGE_LIFETIME_MS / 1000),
            messages: messages
        });
    });

    app.post("/api/cloud-message", (req, res) => {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate");

        const to = cleanCloudField(req.body && req.body.to, CLOUD_TO_MAX);
        const from = cleanCloudField(req.body && req.body.from, CLOUD_FROM_MAX);
        const message = cleanCloudField(
            req.body && req.body.message,
            CLOUD_MESSAGE_MAX
        );

        if (!to || !message) {
            return res.status(400).json({
                success: false,
                status: "invalid",
                error: "Both 'to' and 'message' are required."
            });
        }

        const clientKey = getCloudClientKey(req);
        const now = Date.now();
        const lastSubmit = cloudLastSubmitByKey.get(clientKey) || 0;
        const waitMs = CLOUD_SUBMIT_COOLDOWN_MS - (now - lastSubmit);

        if (waitMs > 0) {
            return res.status(429).json({
                success: false,
                status: "cooldown",
                error: "Please wait before sending another cloud message.",
                retryAfterSeconds: Math.ceil(waitMs / 1000)
            });
        }

        cloudLastSubmitByKey.set(clientKey, now);
        cleanupCloudMessages();

        const newCloudMessage = {
            id: nextCloudMessageId++,
            to: to,
            from: from || "Anonymous",
            message: message,
            createdAt: now
        };

        cloudMessages.push(newCloudMessage);

        while (cloudMessages.length > CLOUD_MAX_ACTIVE) {
            cloudMessages.shift();
        }

        console.log(
            "CLOUD MESSAGE:",
            newCloudMessage.from,
            "->",
            newCloudMessage.to,
            ":",
            newCloudMessage.message,
            "| ACTIVE:",
            cloudMessages.length
        );

        return res.status(201).json({
            success: true,
            status: "sent",
            ...newCloudMessage,
            expiresAt: now + CLOUD_MESSAGE_LIFETIME_MS,
            activeCount: cloudMessages.length,
            maxActive: CLOUD_MAX_ACTIVE
        });
    });


    // ======================================================
    // CLEAN TEXT
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

        const lower =
            title.toLowerCase();

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

    function fetchText(
        urlString,
        timeout = 8000,
        redirects = 0
    ) {

        return new Promise((resolve, reject) => {

            if (redirects > 5) {

                reject(
                    new Error("Too many redirects")
                );

                return;
            }


            let url;

            try {

                url =
                    new URL(urlString);
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

                hostname:
                    url.hostname,

                port:
                    url.port ||
                    (
                        url.protocol === "https:"
                            ? 443
                            : 80
                    ),

                path:
                    url.pathname +
                    url.search,

                method:
                    "GET",

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
                client.request(
                    options,
                    response => {

                        // -----------------------------
                        // REDIRECT
                        // -----------------------------

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


                        // -----------------------------
                        // HTTP ERROR
                        // -----------------------------

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


                        response.on(
                            "data",
                            chunk => {

                                if (
                                    !Buffer.isBuffer(chunk)
                                ) {

                                    chunk =
                                        Buffer.from(chunk);
                                }


                                chunks.push(chunk);

                                totalLength +=
                                    chunk.length;


                                if (
                                    totalLength >
                                    2000000
                                ) {

                                    response.destroy();
                                }
                            }
                        );


                        response.on(
                            "end",
                            () => {

                                const buffer =
                                    Buffer.concat(
                                        chunks
                                    );


                                resolve(
                                    buffer.toString(
                                        "utf8"
                                    )
                                );
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
    // ICY METADATA
    // ======================================================

    function getIcyStreamTitle(
        streamUrl,
        redirects = 0
    ) {

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

                url =
                    new URL(streamUrl);
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

                hostname:
                    url.hostname,

                port:
                    url.port ||
                    (
                        url.protocol === "https:"
                            ? 443
                            : 80
                    ),

                path:
                    url.pathname +
                    url.search,

                method:
                    "GET",

                headers: {

                    "Icy-MetaData":
                        "1",

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
                client.request(
                    options,
                    response => {

                        // -----------------------------
                        // REDIRECT
                        // -----------------------------

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


                        if (
                            !metaInt ||
                            metaInt <= 0
                        ) {

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
                                    offset <
                                    chunk.length
                                ) {

                                    // -------------------------
                                    // SKIP AUDIO
                                    // -------------------------

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


                                    // -------------------------
                                    // METADATA LENGTH
                                    // -------------------------

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

                                            metadata =
                                                Buffer.alloc(0);

                                            continue;
                                        }
                                    }


                                    // -------------------------
                                    // READ METADATA
                                    // -------------------------

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


                                    offset +=
                                        amount;


                                    // -------------------------
                                    // COMPLETE METADATA
                                    // -------------------------

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
                    }
                );


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
    // RADIO SERVER BASE
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


        if (
            Array.isArray(obj)
        ) {

            for (
                const item of obj
            ) {

                const found =
                    findTitleInObject(
                        item
                    );

                if (found)
                    return found;
            }

            return null;
        }


        if (
            typeof obj !==
            "object"
        ) {

            return null;
        }


        if (
            obj.artist &&
            obj.title &&
            typeof obj.artist !==
                "object" &&
            typeof obj.title !==
                "object"
        ) {

            const artist =
                cleanTitle(
                    obj.artist
                );

            const song =
                cleanTitle(
                    obj.title
                );


            if (
                artist &&
                song
            ) {

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


        for (
            const field of fields
        ) {

            if (
                Object.prototype
                    .hasOwnProperty
                    .call(
                        obj,
                        field
                    )
            ) {

                const value =
                    obj[field];


                if (
                    value &&
                    typeof value ===
                    "object"
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
                        cleanTitle(
                            value
                        );


                    if (title)
                        return title;
                }
            }
        }


        if (
            obj.title &&
            typeof obj.title !==
            "object"
        ) {

            const title =
                cleanTitle(
                    obj.title
                );


            if (title)
                return title;
        }


        for (
            const key of
            Object.keys(obj)
        ) {

            const value =
                obj[key];


            if (
                value &&
                typeof value ===
                "object"
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
    // SHOUTCAST INDEX
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
                    .replace(
                        /\r/g,
                        " "
                    )
                    .replace(
                        /\n/g,
                        " "
                    )
                    .replace(
                        /\t/g,
                        " "
                    );


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
    // SHOUTCAST /7.HTML
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

            // Continue.
        }


        return null;
    }


    // ======================================================
    // CURRENT SONG ENDPOINT
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
    // ICECAST JSON
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
    // SHOUTCAST STATS
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
    // MASTER RADIO LOOKUP
    // ======================================================

    async function getStreamTitle(streamUrl) {

        console.log(
            "Checking metadata for:",
            streamUrl
        );


        // 1. ICY

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


        // 2. SHOUTCAST PAGE

        let title =
            await tryShoutcastIndex(
                base
            );


        if (title)
            return title;


        // 3. CURRENTSONG

        title =
            await tryCurrentSong(
                base
            );


        if (title)
            return title;


        // 4. STATS

        title =
            await tryShoutcastStats(
                base
            );


        if (title)
            return title;


        // 5. ICECAST

        title =
            await tryIcecastJSON(
                base
            );


        if (title)
            return title;


        // 6. /7.HTML

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


            if (
                cleaned &&
                cleaned !==
                currentTitle
            ) {

                currentTitle =
                    cleaned;

                // ==================================================
                // RESET MASTER SONG CLOCK
                // ==================================================

                // Every Lyrics TV will use this same timestamp.
                // This prevents a TV loaded in the middle of a song
                // from starting the lyrics back at the beginning.
                songStartedAt =
                    Date.now();


                // Clear lyrics cache
                lyricsCache = {
                    title: null,
                    result: null,
                    updated: 0
                };

                videoCache = {
                    title: null,
                    result: null,
                    updated: 0
                };


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
    // SPLIT ARTIST / SONG
    // ======================================================

    function splitArtistAndSong(fullTitle) {

        if (!fullTitle) {

            return {
                artist: null,
                song: null
            };
        }


        const separator =
            fullTitle.indexOf(
                " - "
            );


        if (
            separator === -1
        ) {

            return {
                artist: null,
                song:
                    fullTitle.trim()
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
    // LYRICS SEARCH CLEANUP
    // ======================================================

    function removeFeaturedArtists(song) {

        if (!song)
            return song;


        return String(song)

            // ft. Artist
            .replace(
                /\s+(?:ft\.?|feat\.?|featuring)\s+.+$/i,
                ""
            )

            // (feat. Artist)
            .replace(
                /\s*\((?:ft\.?|feat\.?|featuring)\s+[^)]*\)/gi,
                ""
            )

            // [feat. Artist]
            .replace(
                /\s*\[(?:ft\.?|feat\.?|featuring)\s+[^\]]*\]/gi,
                ""
            )

            .replace(
                /\s+/g,
                " "
            )

            .trim();
    }


    function removeVersionInfo(song) {

        if (!song)
            return song;


        return String(song)

            .replace(
                /\s*\((?:official\s*)?(?:audio|video|lyrics|music video)\)\s*/gi,
                " "
            )

            .replace(
                /\s*\[(?:official\s*)?(?:audio|video|lyrics|music video)\]\s*/gi,
                " "
            )

            .replace(
                /\s*\((?:radio edit|radio version|album version|clean|explicit)\)\s*/gi,
                " "
            )

            .replace(
                /\s*\[(?:radio edit|radio version|album version|clean|explicit)\]\s*/gi,
                " "
            )

            .replace(
                /\s+/g,
                " "
            )

            .trim();
    }


    function removeRemixInfo(song) {

        if (!song)
            return song;


        return String(song)

            .replace(
                /\s*[\(\[][^)\]]*remix[^)\]]*[\)\]]/gi,
                " "
            )

            .replace(
                /\s+-\s+.*remix.*$/gi,
                ""
            )

            .replace(
                /\s+/g,
                " "
            )

            .trim();
    }


    // ======================================================
    // CREATE MULTIPLE TITLE VERSIONS
    // ======================================================

    function createSongVariants(song) {

        const variants = [];


        function add(value) {

            if (!value)
                return;


            value =
                String(value)
                    .replace(
                        /\s+/g,
                        " "
                    )
                    .trim();


            if (
                value &&
                !variants.includes(value)
            ) {

                variants.push(value);
            }
        }


        // Original
        add(song);


        // Remove radio/version labels
        const noVersion =
            removeVersionInfo(song);

        add(noVersion);


        // Remove featured artist
        const noFeature =
            removeFeaturedArtists(
                noVersion
            );

        add(noFeature);


        // Remove remix info
        const noRemix =
            removeRemixInfo(
                noFeature
            );

        add(noRemix);


        // Example:
        // G.O.A.T. 2.0 -> G.O.A.T.

        const noVersionNumber =
            noRemix
                .replace(
                    /\s+\d+\.\d+\s*$/i,
                    ""
                )
                .trim();

        add(noVersionNumber);


        // Remove trailing dash information
        const noTrailing =
            noVersionNumber
                .replace(
                    /\s+-\s+.+$/,
                    ""
                )
                .trim();

        add(noTrailing);


        return variants;
    }


    // ======================================================
    // NORMALIZE MATCHING
    // ======================================================

    function normalizeLyricsText(value) {

        return String(
            value || ""
        )
            .toLowerCase()

            .replace(
                /&/g,
                " and "
            )

            .replace(
                /[^a-z0-9]+/g,
                " "
            )

            .replace(
                /\s+/g,
                " "
            )

            .trim();
    }


    // ======================================================
    // SCORE LRCLIB RESULT
    // ======================================================

    function scoreLyricsResult(
        item,
        wantedArtist,
        wantedSong
    ) {

        if (!item)
            return -1000;


        let score = 0;


        const resultArtist =
            normalizeLyricsText(
                item.artistName
            );


        const resultSong =
            normalizeLyricsText(
                item.trackName
            );


        const artist =
            normalizeLyricsText(
                wantedArtist
            );


        const song =
            normalizeLyricsText(
                wantedSong
            );


        // SONG

        if (
            resultSong === song
        ) {

            score += 150;
        }

        else if (
            resultSong.includes(song) ||
            song.includes(resultSong)
        ) {

            score += 80;
        }


        // ARTIST

        if (
            artist &&
            resultArtist === artist
        ) {

            score += 150;
        }

        else if (
            artist &&
            (
                resultArtist.includes(
                    artist
                ) ||
                artist.includes(
                    resultArtist
                )
            )
        ) {

            score += 70;
        }


        // Prefer synced lyrics

        if (
            item.syncedLyrics &&
            item.syncedLyrics.trim()
        ) {

            score += 40;
        }


        // Plain lyrics

        if (
            item.plainLyrics &&
            item.plainLyrics.trim()
        ) {

            score += 20;
        }


        // Instrumental penalty

        if (
            item.instrumental === true
        ) {

            score -= 200;
        }


        return score;
    }


    // ======================================================
    // SEARCH ONE LRCLIB QUERY
    // ======================================================

    async function searchLRCLIBQuery(
        query,
        artist,
        song
    ) {

        const url =
            "https://lrclib.net/api/search?q=" +
            encodeURIComponent(query);


        console.log(
            "LRCLIB TRY:",
            query
        );


        let text;


        try {

            text =
                await fetchText(
                    url,
                    10000
                );
        }

        catch (error) {

            console.log(
                "LRCLIB REQUEST FAILED:",
                error.message
            );

            return null;
        }


        let results;


        try {

            results =
                JSON.parse(text);
        }

        catch (error) {

            console.log(
                "LRCLIB INVALID JSON"
            );

            return null;
        }


        if (
            !Array.isArray(results) ||
            results.length === 0
        ) {

            console.log(
                "LRCLIB NO RESULTS:",
                query
            );

            return null;
        }


        let best = null;

        let bestScore =
            -1000;


        for (
            const item of results
        ) {

            const score =
                scoreLyricsResult(
                    item,
                    artist,
                    song
                );


            if (
                score >
                bestScore
            ) {

                bestScore =
                    score;

                best =
                    item;
            }
        }


        if (!best)
            return null;


        console.log(
            "LRCLIB POSSIBLE MATCH:",
            best.artistName,
            "-",
            best.trackName,
            "SCORE:",
            bestScore
        );


        return {
            item: best,
            score: bestScore
        };
    }


    // ======================================================
    // SMART LRCLIB SEARCH
    // ======================================================

    async function searchLRCLIB(
        artist,
        originalSong
    ) {

        if (!originalSong)
            return null;


        const variants =
            createSongVariants(
                originalSong
            );


        console.log(
            "================================"
        );

        console.log(
            "LRCLIB SMART SEARCH"
        );

        console.log(
            "ARTIST:",
            artist
        );

        console.log(
            "ORIGINAL SONG:",
            originalSong
        );

        console.log(
            "VARIANTS:",
            variants
        );

        console.log(
            "================================"
        );


        let bestOverall = null;

        let bestOverallScore =
            -1000;


        // --------------------------------------------------
        // TRY EVERY TITLE VERSION
        // --------------------------------------------------

        for (
            const song of variants
        ) {

            const queries = [];


            // Artist + Song
            if (artist) {

                queries.push(
                    artist +
                    " " +
                    song
                );
            }


            // Song only
            queries.push(song);


            for (
                const query of queries
            ) {

                const result =
                    await searchLRCLIBQuery(
                        query,
                        artist,
                        song
                    );


                if (!result)
                    continue;


                if (
                    result.score >
                    bestOverallScore
                ) {

                    bestOverall =
                        result.item;

                    bestOverallScore =
                        result.score;
                }


                // Strong match.
                // Stop searching.

                if (
                    result.score >= 300
                ) {

                    console.log(
                        "LRCLIB STRONG MATCH FOUND"
                    );


                    return result.item;
                }
            }
        }


        // --------------------------------------------------
        // ACCEPT GOOD FALLBACK
        // --------------------------------------------------

        if (
            bestOverall &&
            bestOverallScore >= 130
        ) {

            console.log(
                "LRCLIB BEST FALLBACK:",
                bestOverall.artistName,
                "-",
                bestOverall.trackName,
                "SCORE:",
                bestOverallScore
            );


            return bestOverall;
        }


        console.log(
            "LRCLIB: NO SAFE MATCH FOUND"
        );


        return null;
    }


    // ======================================================
    // GET CURRENT LYRICS
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


        // --------------------------------------------------
        // CACHE
        // --------------------------------------------------

        if (
            lyricsCache.title ===
                title &&
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


            // --------------------------------------------------
            // NOTHING FOUND
            // --------------------------------------------------

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

                    searchedVariants:
                        createSongVariants(
                            info.song
                        ),

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


            // --------------------------------------------------
            // MATCH FOUND
            // --------------------------------------------------

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
                    new Date()
                        .toISOString()
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


            console.log(
                "LYRICS READY:",
                result.status,
                result.matchedArtist,
                "-",
                result.matchedSong
            );


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
    // YOUTUBE MUSIC VIDEO SEARCH
    // ======================================================

    function normalizeVideoText(value) {
        return String(value || "")
            .toLowerCase()
            .replace(/&amp;/g, " and ")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, "\"")
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    function scoreYouTubeResult(item, artist, song) {
        if (!item || !item.snippet) return -1000;

        const title = normalizeVideoText(item.snippet.title);
        const channel = normalizeVideoText(item.snippet.channelTitle);
        const wantedArtist = normalizeVideoText(artist);
        const wantedSong = normalizeVideoText(
            removeFeaturedArtists(removeVersionInfo(song))
        );

        let score = 0;

        if (wantedSong && title.includes(wantedSong)) score += 140;
        if (
            wantedArtist &&
            (title.includes(wantedArtist) || channel.includes(wantedArtist))
        ) score += 120;

        if (
            title.includes("official music video") ||
            title.includes("official video")
        ) score += 90;

        if (
            channel.includes("vevo") ||
            (wantedArtist && channel.includes(wantedArtist))
        ) score += 45;

        if (title.includes("lyric video")) score -= 130;
        if (title.includes("lyrics")) score -= 80;
        if (title.includes("audio")) score -= 70;
        if (title.includes("visualizer")) score -= 55;
        if (title.includes("reaction")) score -= 180;
        if (title.includes("cover")) score -= 110;
        if (title.includes("karaoke")) score -= 180;
        if (title.includes("instrumental")) score -= 180;
        if (title.includes("live")) score -= 60;

        return score;
    }

    async function searchYouTubeMusicVideo(artist, song) {
  const overrideVideoId = getOfficialVideoOverride(artist, song);
  if (overrideVideoId) {
    console.log("YOUTUBE OFFICIAL OVERRIDE:", artist, "-", song, "=>", overrideVideoId);
    return {
      videoId: overrideVideoId,
      videoTitle: `${artist} - ${song} (Official Music Video)`,
      channelTitle: "Official override",
      thumbnail: `https://i.ytimg.com/vi/${overrideVideoId}/hqdefault.jpg`,
      query: "official override",
      score: 10000,
      override: true
    };
  }

        if (Date.now() < youtubeSearchBackoffUntil) {
            const retryMinutes = Math.max(1, Math.ceil((youtubeSearchBackoffUntil - Date.now()) / 60000));
            const error = new Error(`YouTube search temporarily paused after quota/rate limit. Retry in about ${retryMinutes} minute(s).`);
            error.code = "YOUTUBE_BACKOFF";
            throw error;
        }

        if (!YOUTUBE_API_KEY) {
            throw new Error("YOUTUBE_API_KEY is not configured");
        }

        const cleanSong = removeVersionInfo(song);
        const noFeature = removeFeaturedArtists(cleanSong);

        const query = [
            artist || "",
            noFeature || cleanSong || song || "",
            "official music video"
        ].filter(Boolean).join(" ").trim();

        if (!query) return null;

        const url =
            "https://www.googleapis.com/youtube/v3/search" +
            "?part=snippet" +
            "&type=video" +
            "&maxResults=10" +
            "&videoEmbeddable=true" +
            "&videoSyndicated=true" +
            "&safeSearch=moderate" +
            "&regionCode=US" +
            "&q=" + encodeURIComponent(query) +
            "&key=" + encodeURIComponent(YOUTUBE_API_KEY);

        console.log("YOUTUBE VIDEO SEARCH:", query);

        const text = await fetchText(url, 10000);
        const data = JSON.parse(text);

        if (!data || !Array.isArray(data.items) || data.items.length === 0) {
            return null;
        }

        let best = null;
        let bestScore = -1000;

        for (const item of data.items) {
            if (!item.id || !item.id.videoId) continue;

            const score = scoreYouTubeResult(item, artist, song);

            if (score > bestScore) {
                bestScore = score;
                best = item;
            }
        }

        if (!best) return null;

        console.log(
            "YOUTUBE VIDEO MATCH:",
            best.snippet.title,
            "SCORE:",
            bestScore
        );

        const thumbs = best.snippet.thumbnails || {};
        const thumb = thumbs.high || thumbs.medium || thumbs.default || null;

        return {
            videoId: best.id.videoId,
            videoTitle: decodeText(best.snippet.title),
            channelTitle: decodeText(best.snippet.channelTitle),
            thumbnail: thumb ? thumb.url : null,
            score: bestScore,
            query: query
        };
    }

    async function getCurrentMusicVideo() {
        const title = currentTitle;

        if (
            !title ||
            title === "Connecting to Slow Tide..." ||
            title === "Connecting to new station..." ||
            title === "Waiting for song information..."
        ) {
            return {
                success: false,
                status: "waiting",
                title: title,
                message: "Waiting for song information."
            };
        }

        const elapsed = () =>
            Math.max(0, (Date.now() - songStartedAt) / 1000);

        if (videoCache.title === title && videoCache.result) {
            return {
                ...videoCache.result,
                songStartedAt: songStartedAt,
                songElapsedSeconds: elapsed()
            };
        }

        const info = splitArtistAndSong(title);

        if (!info.song) {
            return {
                success: false,
                status: "unavailable",
                title: title,
                artist: info.artist,
                song: info.song,
                message: "Unable to determine song title."
            };
        }

        try {
            const match = await searchYouTubeMusicVideo(info.artist, info.song);

            let result;

            if (!match) {
                result = {
                    success: false,
                    status: "unavailable",
                    title: title,
                    artist: info.artist,
                    song: info.song,
                    message: "No embeddable music video found.",
                    source: "YouTube"
                };
            } else {
                result = {
                    success: true,
                    status: "ready",
                    title: title,
                    artist: info.artist,
                    song: info.song,
                    videoId: match.videoId,
                    videoTitle: match.videoTitle,
                    channelTitle: match.channelTitle,
                    thumbnail: match.thumbnail,
                    query: match.query,
                    source: "YouTube",
                    muted: true
                };
            }

            videoCache = {
                title: title,
                result: result,
                updated: Date.now()
            };

            return {
                ...result,
                songStartedAt: songStartedAt,
                songElapsedSeconds: elapsed()
            };
        } catch (error) {
            console.log("YOUTUBE VIDEO ERROR:", error.message);

            const is429 = /HTTP\s*429/i.test(String(error.message || ""));

            if (is429) {
                youtubeSearchBackoffUntil = Date.now() + YOUTUBE_429_BACKOFF_MS;
                console.log(
                    "YOUTUBE SEARCH BACKOFF ENABLED UNTIL:",
                    new Date(youtubeSearchBackoffUntil).toISOString()
                );
            }

            // IMPORTANT: cache failures for this song too. video.html polls
            // /api/video frequently; without this cache every poll would make
            // another YouTube search request and burn quota.
            const errorResult = {
                success: false,
                status: is429 ? "quota_wait" : "error",
                title: title,
                artist: info.artist,
                song: info.song,
                message: is429
                    ? "YouTube search quota is temporarily unavailable. Slow Tide will wait before searching again."
                    : error.message,
                source: "YouTube",
                retryAfterSeconds: is429
                    ? Math.ceil(YOUTUBE_429_BACKOFF_MS / 1000)
                    : null
            };

            videoCache = {
                title: title,
                result: errorResult,
                updated: Date.now()
            };

            return {
                ...errorResult,
                songStartedAt: songStartedAt,
                songElapsedSeconds: elapsed()
            };
        }
    }

    // VIDEO API
    app.get("/api/video", async (req, res) => {
        res.set("Cache-Control", "no-store, no-cache, must-revalidate");

        try {
            res.json(await getCurrentMusicVideo());
        } catch (error) {
            res.status(500).json({
                success: false,
                status: "error",
                message: "Unable to retrieve music video."
            });
        }
    });


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

                online:
                    true,

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

                // Shared master clock for all Lyrics TVs
                songStartedAt:
                    songStartedAt,

                // Convenient current position in the song
                songElapsedSeconds:
                    Math.max(
                        0,
                        (Date.now() - songStartedAt) / 1000
                    ),

                updated:
                    new Date()
                        .toISOString()
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


                res
                    .status(500)
                    .json({

                        success:
                            false,

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
    // ======================================================

    app.post(
        "/api/set-stream",
        async (req, res) => {

            let stream =
                req.body &&
                req.body.stream;


            if (
                !stream ||
                typeof stream !==
                "string"
            ) {

                return res
                    .status(400)
                    .json({

                        success:
                            false,

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
                    parsed.protocol !==
                        "http:" &&
                    parsed.protocol !==
                        "https:"
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

                        success:
                            false,

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

                // Reset sync while the new station connects.
                // It will reset again when the first real song
                // from the new station is detected.
                songStartedAt =
                    Date.now();


                lyricsCache = {
                    title: null,
                    result: null,
                    updated: 0
                };


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


            res
                .status(200)
                .json({

                    success:
                        true,

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
    // MANUAL REFRESH
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

                success:
                    true,

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
                "Music Video TV: /video"
            );

            console.log(
                "Music Video API: /api/video"
            );

            console.log(
                "SMART LYRIC MATCHING: ON"
            );

            console.log(
                "================================"
            );


            setTimeout(
                updateNowPlaying,
                1000
            );


            // Check radio metadata every 3 seconds.
            // This detects song changes much faster and improves
            // lyric synchronization.
            setInterval(
                updateNowPlaying,
                3000
            );
        }
    );
