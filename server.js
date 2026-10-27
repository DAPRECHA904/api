    const express = require("express");
    const http = require("http");
    const https = require("https");
    const path = require("path");
    const fs = require("fs");
    const { spawn } = require("child_process");

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

    // Follow the station selected before the last deployment.
    // Never reset to Nasty Seduction simply because Render restarts.
    let currentStream =
        process.env.SLOW_TIDE_DEFAULT_STREAM || "http://gostream.store:8678";

    let currentTitle =
        "Connecting to Slow Tide...";

    let checking = false;

    // A single stray/early radio title must not switch both TVs.
    // Require two consecutive observations from the selected station.
    let pendingRadioTitle = null;
    let pendingRadioTitleCount = 0;
    let pendingRadioTitleStream = null;
    const RADIO_TITLE_CONFIRMATIONS = 2;

    // ======================================================
    // MASTER SONG SYNC CLOCK
    // ======================================================

    // Shared server clock used by every Slow Tide Lyrics TV.
    // This resets whenever the server detects a new song.
    let songStartedAt = Date.now();

    // Changes whenever the active station or song changes.
    // Async lyric lookups may only publish results from the current generation.
    let songGeneration = 0;

    // Last automatic sync method used (diagnostic only).
    let autoSyncMethod = "fallback";

    // Radio/lyrics synchronization compensation.
    // Calibrated for the current Slow Tide radio path.
    // Adjust only if repeated multi-song testing shows a consistent offset.
    const MASTER_SYNC_COMPENSATION_SECONDS = 0;



    // ======================================================
    // LIVE-AUDIO SONG START DETECTOR v2
    // ======================================================
    // Keep one continuous ffmpeg connection open around a metadata change.
    // This avoids reconnecting to the radio for every sample (which caused
    // identical 0.000 fingerprints). Metadata identifies the next song;
    // the live PCM stream determines when its audio actually changes.
    const AUDIO_SYNC_ENABLED = false;
    const AUDIO_SYNC_MAX_WAIT_SECONDS = 45;
    const AUDIO_SYNC_WINDOW_MS = 500;
    const AUDIO_SYNC_CHANGE_THRESHOLD = 0.30;
    const AUDIO_SYNC_CONFIRM_WINDOWS = 2;

    let audioSyncToken = 0;

    function alignClockToLiveAudio(streamUrl, generation, metadataSeenAt) {
        if (!AUDIO_SYNC_ENABLED) return Promise.resolve();

        const myToken = ++audioSyncToken;

        return new Promise(resolve => {
            const args = [
                "-hide_banner", "-loglevel", "error",
                "-i", streamUrl,
                "-vn",
                "-ac", "1",
                "-ar", "8000",
                "-f", "s16le",
                "pipe:1"
            ];

            const ff = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "ignore"] });
            let pcm = Buffer.alloc(0);
            let baseline = null;
            let confirmCount = 0;
            let finished = false;

            // 8 kHz mono, signed 16-bit = 16,000 bytes/sec.
            const windowBytes = Math.floor(16000 * (AUDIO_SYNC_WINDOW_MS / 1000));

            function finish(message) {
                if (finished) return;
                finished = true;
                clearTimeout(timeout);
                try { ff.kill("SIGKILL"); } catch (_) {}
                if (message) console.log(message);
                resolve();
            }

            function fingerprint(buffer) {
                // Compare both amplitude and zero-crossing behavior across 32 bins.
                const bins = 32;
                const samples = Math.floor(buffer.length / 2);
                const perBin = Math.max(2, Math.floor(samples / bins));
                const fp = [];

                for (let bin = 0; bin < bins; bin++) {
                    const start = bin * perBin;
                    const end = Math.min(samples, start + perBin);
                    let absSum = 0;
                    let crossings = 0;
                    let previous = null;
                    let count = 0;

                    for (let i = start; i < end; i++) {
                        const v = buffer.readInt16LE(i * 2) / 32768;
                        absSum += Math.abs(v);
                        if (previous !== null && ((previous < 0 && v >= 0) || (previous >= 0 && v < 0))) {
                            crossings++;
                        }
                        previous = v;
                        count++;
                    }

                    fp.push(count ? absSum / count : 0);
                    fp.push(count > 1 ? crossings / (count - 1) : 0);
                }
                return fp;
            }

            function distance(a, b) {
                if (!a || !b || a.length !== b.length) return 1;
                let diff = 0;
                let base = 0;
                for (let i = 0; i < a.length; i++) {
                    diff += Math.abs(a[i] - b[i]);
                    base += Math.max(Math.abs(a[i]), Math.abs(b[i]), 0.01);
                }
                return diff / base;
            }

            const timeout = setTimeout(() => {
                finish("AUDIO SYNC v2: no reliable transition found; metadata clock retained.");
            }, AUDIO_SYNC_MAX_WAIT_SECONDS * 1000);

            ff.on("error", error => {
                finish("AUDIO SYNC v2 FALLBACK: ffmpeg unavailable: " + error.message);
            });

            ff.stdout.on("data", chunk => {
                if (
                    finished ||
                    myToken !== audioSyncToken ||
                    generation !== songGeneration ||
                    streamUrl !== currentStream
                ) {
                    finish();
                    return;
                }

                pcm = Buffer.concat([pcm, chunk]);

                while (pcm.length >= windowBytes && !finished) {
                    const window = pcm.subarray(0, windowBytes);
                    pcm = pcm.subarray(windowBytes);
                    const fp = fingerprint(window);

                    if (!baseline) {
                        baseline = fp;
                        console.log("AUDIO SYNC v2: continuous stream baseline captured.");
                        continue;
                    }

                    const score = distance(baseline, fp);
                    console.log("AUDIO SYNC v2 CHANGE SCORE:", score.toFixed(3));

                    if (score >= AUDIO_SYNC_CHANGE_THRESHOLD) {
                        confirmCount++;
                    } else {
                        confirmCount = 0;
                    }

                    if (confirmCount >= AUDIO_SYNC_CONFIRM_WINDOWS) {
                        // The center of the confirmed 500 ms window is our
                        // best estimate of when the new audio reached Render.
                        songStartedAt = Date.now() - Math.floor(AUDIO_SYNC_WINDOW_MS / 2);
                        autoSyncMethod = "live-audio-transition-v2";

                        console.log(
                            "AUDIO SYNC v2 LOCKED:",
                            new Date(songStartedAt).toISOString(),
                            "| metadata lead ms:",
                            songStartedAt - metadataSeenAt
                        );

                        finish();
                        return;
                    }

                    // Adapt slowly so normal musical dynamics don't trigger a lock.
                    baseline = baseline.map((v, i) => v * 0.97 + fp[i] * 0.03);
                }
            });

            ff.on("close", () => {
                if (!finished) finish("AUDIO SYNC v2: stream process ended before lock.");
            });
        });
    }

    // ======================================================
    // LYRICS CACHE
    // ======================================================

    let lyricsCache = {
        title: null,
        result: null,
        updated: 0
    };

    // One lookup for all lyric TVs, short-lived negative caches, and
    // reusable successful lyrics when a track plays again.
    const lyricsInFlight = new Map();
    const reusableLyricsCache = new Map();
    const LYRICS_NOT_FOUND_RETRY_MS = 45000;
    const LYRICS_ERROR_RETRY_MS = 20000;
    const LYRICS_SAVED_LIMIT = 120;
    let lrclibBlockedUntil = 0;
    let lastLrclibRequestAt = 0;

    const lyricsDelay = ms => new Promise(resolve => setTimeout(resolve, ms));


    // YOUTUBE MUSIC VIDEO
    const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || "";

// KNOWN OFFICIAL MUSIC VIDEO OVERRIDES
// Keys are normalized "artist - song" strings. Add more known official videos here as needed.
const OFFICIAL_VIDEO_OVERRIDES = {
  "mk xyz - one time": "cLwnojWx0Ac",
  // The Weeknd — Earned It (Fifty Shades of Grey), official video supplied by venue owner.
  "the weeknd - earned it": "waU75jdUnYw",
  "the weeknd - earned it fifty shades of grey": "waU75jdUnYw",
  "bryson tiller - outside": "UkcOC8YEVMQ",
  "the isley brothers - hello its me": "JHSxgcefIhM",
  "usher - there goes my baby": "m6urbZyHgO4",
  "mya - my love is like wo": "K4gcQj_NZ30",
  "dru hill - these are the times": "6wPkC3DO_7Y",
  "heather headley - i wish i wasnt": "8oz716XcQqU",
  "tyrese - how you gonna act like that": "y3HbIHGnSR4",
  "112 - u already know": "ynMnPGmhsG0",
  "toni braxton - un break my heart": "p2Rch6WvPJE",
  "jagged edge - lets get married": "9XwPCVvMcuE",
  "kelly price - friend of mine remix": "swP0h-K_Tss",
  "tweet - oops oh my": "P5rqNyulfsQ",
  "michael jackson - another part of me": "8vwHQNQ88cM",
  "michael jackson - another part of me 2012 remaster": "8vwHQNQ88cM",
  // Manual video selected for Mary J. Blige — Not Gon Cry.
  "mary j blige - not gon cry": "WiM3bGcXYxk",
  "mary j blige - not goin cry": "WiM3bGcXYxk",
  "mary j blige - not going to cry": "WiM3bGcXYxk"
};

function videoOverrideKey(artist, song) {
  return normalizeVideoText(`${artist || ""} - ${song || ""}`)
    .replace(/\b(feat|ft|featuring)\b.*$/i, "")
    .replace(/\bofficial\b|\bmusic video\b|\bvideo\b/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function getOfficialVideoOverride(artist, song) {
  // Normalize stored override keys too: videoOverrideKey removes punctuation.
  const exact = videoOverrideKey(artist, song);
  const wantedArtist = normalizeVideoText(artist);
  const wantedSong = normalizeVideoText(removeFeaturedArtists(removeVersionInfo(song).replace(/\s*[([]\s*(?:\d{4}\s*)?(?:re-?master(?:ed)?|anniversary edition)(?:\s+version)?\s*[)\]]/gi, "")));
  if (!wantedArtist || !wantedSong) return null;

  for (const [key, videoId] of Object.entries(OFFICIAL_VIDEO_OVERRIDES)) {
    const normalizedKey = normalizeVideoText(key);
    if (normalizedKey === exact ||
        normalizedKey === wantedArtist + " " + wantedSong) {
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

    // ======================================================
    // PERSISTENT YOUTUBE VIDEO CACHE + QUOTA PROTECTION
    // ======================================================
    // search.list costs 100 quota units. Slow Tide therefore searches
    // YouTube only for a song that is not already known. Results are
    // stored on disk when the host filesystem permits it, and always
    // remain cached in memory for the lifetime of this server process.
    const VIDEO_CACHE_FILE = path.join(__dirname, "youtube-video-cache.json");
    const persistentVideoCache = new Map();
    const YOUTUBE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
    const YOUTUBE_CACHE_SELECTION_VERSION = 11;
    function youtubeCacheValid(entry) {
        return entry && entry.selectionVersion === YOUTUBE_CACHE_SELECTION_VERSION &&
            Number.isFinite(entry.cachedAt) &&
            Date.now() >= entry.cachedAt &&
            Date.now() - entry.cachedAt < (entry.found
                ? YOUTUBE_CACHE_MAX_AGE_MS : 15 * 60 * 1000);
    }
    const videoSearchesInProgress = new Map();

    // Standard YouTube Data API projects commonly have 10,000 units/day.
    // Leave a safety margin and never allow this app to spend more than
    // 8,000 units (80 search.list calls) in one UTC day.
    const YOUTUBE_SEARCH_COST = 100;
    const YOUTUBE_DAILY_APP_BUDGET = 8000;
    let youtubeQuotaDay = new Date().toISOString().slice(0, 10);
    let youtubeQuotaSpent = 0;

    // If Google returns 429 or quotaExceeded, stop ALL new searches until
    // the next UTC day. Cached/override videos continue to work.
    let youtubeSearchBackoffUntil = 0;

    function youtubeCacheKey(artist, song) {
        const cleanArtist = normalizeVideoText(artist || "");
        const cleanSong = normalizeVideoText(
            removeFeaturedArtists(removeVersionInfo(song || ""))
        );
        return cleanArtist + "|" + cleanSong;
    }

    function resetYoutubeDailyBudgetIfNeeded() {
        const today = new Date().toISOString().slice(0, 10);
        if (today !== youtubeQuotaDay) {
            youtubeQuotaDay = today;
            youtubeQuotaSpent = 0;
            youtubeSearchBackoffUntil = 0;
        }
    }

    function nextUtcDayTimestamp() {
        const now = new Date();
        return Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1,
            0, 5, 0, 0
        );
    }

    function loadPersistentVideoCache() {
        try {
            if (!fs.existsSync(VIDEO_CACHE_FILE)) return;
            const parsed = JSON.parse(fs.readFileSync(VIDEO_CACHE_FILE, "utf8"));
            for (const [key, value] of Object.entries(parsed || {})) {
                if (youtubeCacheValid(value)) {
                    persistentVideoCache.set(key, value);
                }
            }
            console.log("YOUTUBE CACHE LOADED:", persistentVideoCache.size, "songs");
        } catch (error) {
            console.log("YOUTUBE CACHE LOAD WARNING:", error.message);
        }
    }

    function savePersistentVideoCache() {
        try {
            const data = Object.fromEntries(persistentVideoCache.entries());
            fs.writeFileSync(VIDEO_CACHE_FILE, JSON.stringify(data, null, 2), "utf8");
        } catch (error) {
            // Render filesystems may be ephemeral. Memory caching still protects
            // quota for the current process even when disk persistence is unavailable.
            console.log("YOUTUBE CACHE SAVE WARNING:", error.message);
        }
    }

    loadPersistentVideoCache();



    // ======================================================
    // CLOUD MESSAGE STATE + API — MULTI CLOUD VERSION
    // ======================================================

    const CLOUD_MESSAGE_LIFETIME_MS = 20 * 60 * 1000;
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

    function getNextFreeCloudSlot() {
        const usedSlots = new Set(
            cloudMessages
                .map(item => Number(item.slot))
                .filter(slot => slot >= 1 && slot <= CLOUD_MAX_ACTIVE)
        );

        for (let slot = 1; slot <= CLOUD_MAX_ACTIVE; slot++) {
            if (!usedSlots.has(slot)) return slot;
        }

        return null;
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

        const slot = getNextFreeCloudSlot();

        if (slot === null) {
            return res.status(409).json({
                success: false,
                status: "full",
                error: "All cloud message slots are currently in use.",
                activeCount: cloudMessages.length,
                maxActive: CLOUD_MAX_ACTIVE
            });
        }

        const newCloudMessage = {
            id: nextCloudMessageId++,
            slot: slot,
            to: to,
            from: from || "Anonymous",
            message: message,
            createdAt: now
        };

        cloudMessages.push(newCloudMessage);

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
                        url.hostname === "lrclib.net"
                            ? "SlowTideLyricsTV/1.1 (https://slowtide-now-playing.onrender.com)"
                            : "SlowTideLyricsTV/1.0",

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

                            const failure = new Error("HTTP " + response.statusCode);
                            failure.statusCode = response.statusCode;
                            const retryHeader = response.headers["retry-after"];
                            if (retryHeader) {
                                const seconds = Number(retryHeader);
                                const delayMs = Number.isFinite(seconds)
                                    ? Math.max(0, seconds * 1000)
                                    : Math.max(0, Date.parse(retryHeader) - Date.now());
                                if (Number.isFinite(delayMs)) failure.retryAfterMs = delayMs;
                            }
                            reject(failure);

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
            let hardDeadlineTimer = null;



            function success(value) {

                if (settled)
                    return;

                settled = true;
                if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);

                resolve(value);
            }


            function failure(error) {

                if (settled)
                    return;

                settled = true;
                if (hardDeadlineTimer) clearTimeout(hardDeadlineTimer);

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


            // The radio can send audio forever without a song-title frame.
            // An inactivity timeout alone does not stop that stream.
            // Bound the total lookup time, then allow other metadata sources.
            hardDeadlineTimer = setTimeout(() => {
                failure(new Error("ICY metadata deadline (9 seconds) exceeded"));
                request.destroy();
            }, 9000);

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


        // Supreme Element exposes a working "Playing Now" song title on its
        // SHOUTcast status page. Prefer that HTML page on this one station so
        // a live audio connection cannot delay song titles or karaoke updates.
        // Other stations retain the existing ICY-first synchronization path.
        const preferShoutcastPage = (() => {
            try {
                const u = new URL(streamUrl);
                const host = u.hostname.toLowerCase();
                return (host === "supremeelement.filehostia.com" && u.port === "10052") ||
                    // This station has no ICY metadata interval; its status
                    // page reliably reports the current song.
                    (host === "nastyseduction.filehostia.com" && u.port === "8851");
            } catch (_) {
                return false;
            }
        })();

        if (preferShoutcastPage) {
            const titleFromPage = await tryShoutcastIndex(getRadioBase(streamUrl));
            if (titleFromPage) {
                console.log("PREFERRED SHOUTCAST TITLE:", titleFromPage);
                return titleFromPage;
            }
            console.log("Preferred status page had no usable title; trying fallbacks.");
        }

        // 1. ICY (fallback for Supreme Element; primary for other stations)

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


            if (!cleaned) return;

            if (cleaned === currentTitle) {
                pendingRadioTitle = null;
                pendingRadioTitleCount = 0;
                pendingRadioTitleStream = null;
                return;
            }

            if (pendingRadioTitle !== cleaned ||
                pendingRadioTitleStream !== streamBeingChecked) {
                pendingRadioTitle = cleaned;
                pendingRadioTitleStream = streamBeingChecked;
                pendingRadioTitleCount = 1;
                console.log("RADIO TITLE CANDIDATE:", cleaned, "awaiting confirmation");
                return;
            }
            pendingRadioTitleCount++;
            if (pendingRadioTitleCount < RADIO_TITLE_CONFIRMATIONS) return;

            pendingRadioTitle = null;
            pendingRadioTitleCount = 0;
            pendingRadioTitleStream = null;

            if (cleaned !== currentTitle) {

                // Invalidate async lyric/video work from the previous song.
                songGeneration++;

                currentTitle =
                    cleaned;

                // ==================================================
                // RESET MASTER SONG CLOCK
                // ==================================================

                // Every Lyrics TV uses the same title-change clock.
                // IMPORTANT: do not use SHOUTcast PLAYEDAT here. Some stations
                // report automation/server time well before the buffered audio
                // reaches Second Life, which makes lyrics appear too early.
                // The station publishes the next title before its buffered audio
                // reaches Second Life. Delay the song clock so elapsed time reaches
                // zero when the audible song is expected to begin.
                // Station switching remains completely separate and untouched.
                const metadataSeenAt = Date.now();

                songStartedAt =
                    metadataSeenAt + (MASTER_SYNC_COMPENSATION_SECONDS * 1000);
                autoSyncMethod = "metadata-title-change-stable";

                // Stable karaoke mode:
                // v2 live-audio transition locking is disabled because it could
                // false-trigger on normal musical changes and push lyrics ahead.
                // The shared clock starts exactly when the confirmed metadata title
                // changes, matching the earlier 0-second baseline that tested best.
                alignClockToLiveAudio(
                    streamBeingChecked,
                    songGeneration,
                    metadataSeenAt
                ).catch(error => {
                    console.log("AUDIO SYNC ERROR:", error.message);
                });

                console.log(
                    "KARAOKE SYNC v3: metadata title change — stable master clock",
                    MASTER_SYNC_COMPENSATION_SECONDS,
                    "seconds"
                );


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
        const text = String(fullTitle || "").trim();
        if (!text) return {artist: null, song: null};

        // Radio stations commonly send "Artist - Song", "Artist- Song",
        // "Artist -Song", or use an en/em dash. A separator must have
        // whitespace on at least one side so names like JAY-Z stay intact.
        const matched = text.match(/^(.+?)\s+[-–—]\s*(.+)$/) ||
                        text.match(/^(.+?)\s*[-–—]\s+(.+)$/);
        if (matched) {
            return {
                artist: matched[1].trim(),
                song: removeVersionInfo(matched[2].trim())
            };
        }

        return {artist: null, song: removeVersionInfo(text)};
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
                /\s*\((?:radio edit|radio version|album version|clean|clean version|dirty|dirty version|explicit|explicit version)\)\s*/gi,
                " "
            )

            .replace(
                /\s*\[(?:radio edit|radio version|album version|clean|clean version|dirty|dirty version|explicit|explicit version)\]\s*/gi,
                " "
            )

            // Common station/video metadata noise that hurts LRCLIB matching
            .replace(/\s*[\(\[][^)\]]*(?:official|visualizer|lyric video|lyrics video|lyrics? on screen|lyrics? onscreen|on[- ]screen lyrics|audio only|hd|4k)[^)\]]*[\)\]]\s*/gi, " ")
            .replace(/\s+(?:official\s+)?(?:music\s+)?video\s*$/gi, "")
            .replace(/\s+(?:official\s+)?audio\s*$/gi, "")
            .replace(/\s+(?:lyrics?|visualizer|lyrics? on screen)\s*$/gi, "")
            .replace(/\s+\|\s+.*$/g, "")

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


        // Search the clean title first; this prevents bad metadata labels
        // from consuming the limited LRCLIB query budget.
        const noVersion = removeVersionInfo(song);
        add(noVersion);
        // Keep the original as a last-resort variant, not as the first query.
        if (noVersion !== song) add(song);


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
        return String(value || "").normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "").toLowerCase()
            .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ")
            .replace(/\s+/g, " ").trim();
    }

    // Strip guest credits only for lookup, not for radio song-change timing.
    function lyricsLeadArtist(artist) {
        return String(artist || "")
            .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.*$/i, "")
            .replace(/\s+with\s+.+$/i, "").trim();
    }

    function lyricsArtistVariants(artist) {
        const raw = String(artist || "").trim();
        if (!raw) return [];
        const base = lyricsLeadArtist(raw);
        const result = [];
        for (const value of [base, raw,
            /\s+(?:&|and|x|\+)\s+/i.test(base)
                ? base.split(/\s+(?:&|and|x|\+)\s+/i)[0] : ""]) {
            if (value && !result.some(s =>
                normalizeLyricsText(s) === normalizeLyricsText(value))) result.push(value);
        }
        return result.slice(0, 3);
    }

    function lyricsArtistMatches(found, requested) {
        if (!requested) return true;
        const fullFound = normalizeLyricsText(found);
        const fullWanted = normalizeLyricsText(requested);
        if (!fullFound) return false;
        if (fullFound === fullWanted) return true;
        const baseFound = normalizeLyricsText(lyricsLeadArtist(found));
        const baseWanted = normalizeLyricsText(lyricsLeadArtist(requested));
        if (baseFound && baseFound === baseWanted) return true;
        // Collabs sometimes credit the lead artist alone, or both artists.
        // Only compare whole lead-artist names, never arbitrary substrings.
        const main = x => normalizeLyricsText(
            lyricsLeadArtist(x).split(/\s+(?:&|and|x|\+)\s+/i)[0]);
        const leadFound = main(found), leadWanted = main(requested);
        return Boolean(leadFound && leadFound === leadWanted &&
            (baseFound === leadFound || baseWanted === leadWanted));
    }

    function lyricsSongMatches(found, wanted) {
        const norm = s => normalizeLyricsText(
            removeFeaturedArtists(removeVersionInfo(s)));
        return Boolean(norm(found) && norm(found) === norm(wanted));
    }

    function scoreLyricsResult(item, wantedArtist, wantedSong) {
        if (!item || item.instrumental ||
            !(item.syncedLyrics || item.plainLyrics) ||
            !lyricsArtistMatches(item.artistName, wantedArtist) ||
            !lyricsSongMatches(item.trackName, wantedSong)) return -1000;

        return 180 +
            (normalizeLyricsText(item.trackName) === normalizeLyricsText(wantedSong) ? 20 : 0) +
            (normalizeLyricsText(item.artistName) === normalizeLyricsText(wantedArtist) ? 140 : 105) +
            (item.syncedLyrics && item.syncedLyrics.trim() ? 40 : 0) +
            (item.plainLyrics && item.plainLyrics.trim() ? 12 : 0);
    }

    // Use LRCLIB's documented exact-get and structured/keyword search APIs.
    async function searchLRCLIBQuery(query, artist, song, mode = "structured") {
        const params = new URLSearchParams();
        if (mode === "keyword") params.set("q", query);
        else {
            params.set("track_name", song);
            if (artist) params.set("artist_name", artist);
        }
        const url = "https://lrclib.net/api/" +
            (mode === "exact" ? "get?" : "search?") + params.toString();
        console.log("LRCLIB TRY:", mode, query);
        let body;
        for (let attempt = 0; attempt < 2; attempt++) {
            const wait = Math.max(0, lrclibBlockedUntil - Date.now());
            if (wait > 5000) {
                const error = new Error("LRCLIB cooldown active");
                error.retryable = true;
                throw error;
            }
            if (wait) await lyricsDelay(wait);
            await lyricsDelay(Math.max(0, 400 - (Date.now() - lastLrclibRequestAt)));
            lastLrclibRequestAt = Date.now();
            try {
                body = await fetchText(url, 10000);
                break;
            } catch (error) {
                const code = Number(error.statusCode || 0);
                console.log("LRCLIB REQUEST FAILED:", error.message, "MODE:", mode);
                if (code === 404 || code === 400) return null;
                const transient = code === 429 || code >= 500 || code === 0;
                if (!transient) return null;
                error.retryable = true;
                if (code === 429 || code === 503) {
                    lrclibBlockedUntil = Math.max(
                        lrclibBlockedUntil, Date.now() +
                        Math.max(1000, error.retryAfterMs || 1000));
                }
                if (attempt > 0 || lrclibBlockedUntil - Date.now() > 5000) throw error;
                if (code !== 429 && code !== 503) await lyricsDelay(700);
            }
        }
        let results;
        try {
            const parsed = JSON.parse(body);
            results = mode === "exact" ? [parsed] : parsed;
            if (!Array.isArray(results)) throw new Error("Invalid LRCLIB response");
        } catch (error) {
            error.retryable = true;
            console.log("LRCLIB INVALID RESPONSE:", error.message);
            throw error;
        }
        let best = null, bestScore = -1000;
        for (const item of results) {
            const score = scoreLyricsResult(item, artist, song);
            if (score > bestScore) {best = item; bestScore = score;}
        }
        if (!best || bestScore < 0) {
            console.log("LRCLIB NO SAFE MATCH:", query);
            return null;
        }
        console.log("LRCLIB SAFE MATCH:", best.artistName, "-", best.trackName,
            "SCORE:", bestScore);
        return {item: best, score: bestScore};
    }

    async function searchLRCLIB(artist, originalSong) {
        if (!originalSong) return null;
        const variants = createSongVariants(originalSong).slice(0, 4);
        const artists = lyricsArtistVariants(artist);
        console.log("LRCLIB SMART SEARCH:", artist, "-", originalSong,
            "| ARTIST VARIANTS:", artists, "| SONG VARIANTS:", variants);
        let best = null, bestScore = -1000, errorSeen = null, requests = 0;
        const tried = new Set();
        async function tryLookup(mode, a, song) {
            const query = [a, song].filter(Boolean).join(mode === "keyword" ? " " : " - ");
            const key = mode + "|" + normalizeLyricsText(query);
            if (tried.has(key) || requests >= 10) return;
            tried.add(key);
            requests++;
            try {
                const found = await searchLRCLIBQuery(query, a, song, mode);
                if (found && found.score > bestScore) {
                    best = found.item; bestScore = found.score;
                }
            } catch (error) {
                errorSeen = error;
            }
        }
        for (const song of variants) {
            if (artists.length) {
                for (const a of artists) {
                    await tryLookup("exact", a, song);
                    if (bestScore >= 300) return best;
                    if (errorSeen && errorSeen.retryable) break;
                    await tryLookup("structured", a, song);
                    if (bestScore >= 300) return best;
                    if (errorSeen && errorSeen.retryable) break;
                }
                if (errorSeen && errorSeen.retryable) break;
                await tryLookup("keyword", artists[0], song);
            } else {
                await tryLookup("keyword", "", song);
            }
            if (bestScore >= 300 || requests >= 10 ||
                (errorSeen && errorSeen.retryable)) break;
        }
        if (best && bestScore >= 260) return best;
        if (errorSeen) throw errorSeen;
        console.log("LRCLIB: NO VERIFIED MATCH FOUND");
        return null;
    }


    // ======================================================
    // GET CURRENT LYRICS

    // ======================================================

    async function resolveCurrentLyrics() {

        const title =
            currentTitle;

        const stream =
            currentStream;

        const generation =
            songGeneration;


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

        if (lyricsCache.title === title && lyricsCache.result) {
            const ttl = lyricsCache.result.success
                ? Infinity
                : (lyricsCache.result.status === "error"
                    ? LYRICS_ERROR_RETRY_MS
                    : LYRICS_NOT_FOUND_RETRY_MS);
            if (Date.now() - lyricsCache.updated < ttl) {
                return lyricsCache.result;
            }
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


        const trackKey = normalizeLyricsText(info.artist) + "|" +
            normalizeLyricsText(removeVersionInfo(info.song));
        const previouslyFound = reusableLyricsCache.get(trackKey);
        if (previouslyFound) {
            const result = {...previouslyFound, artist: info.artist,
                song: info.song, title: title};
            lyricsCache = {title, result, updated: Date.now()};
            return result;
        }

        try {

            const match =
                await searchLRCLIB(
                    info.artist,
                    info.song
                );


            // The station/song may have changed while LRCLIB was searching.
            // Never let an old request repopulate the cache or reach a TV.
            if (
                generation !== songGeneration ||
                stream !== currentStream ||
                title !== currentTitle
            ) {

                console.log(
                    "DISCARDING OLD LYRICS RESULT:",
                    title,
                    "| CURRENT:",
                    currentTitle
                );

                return {
                    success: false,
                    status: "changed",
                    title: currentTitle,
                    message: "Song or station changed while lyrics were loading."
                };
            }


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

            if (result.success) {
                reusableLyricsCache.delete(trackKey);
                reusableLyricsCache.set(trackKey, result);
                if (reusableLyricsCache.size > LYRICS_SAVED_LIMIT) {
                    reusableLyricsCache.delete(reusableLyricsCache.keys().next().value);
                }
            }

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


            const failed = {
                success: false,
                status: "error",
                artist: info.artist,
                song: info.song,
                title,
                message: "Lyrics service temporarily unavailable; retrying automatically.",
                retryAfterSeconds: Math.ceil(LYRICS_ERROR_RETRY_MS / 1000),
                source: "LRCLIB"
            };
            // A temporary failure must not remain cached for an entire track.
            if (generation === songGeneration && stream === currentStream &&
                title === currentTitle) {
                lyricsCache = {title, result: failed, updated: Date.now()};
            }
            return failed;
        }
    }



    // Deduplicate simultaneous requests from multiple in-world TVs.
    // Keep the karaoke clock completely separate from lookup retries.
    function getCurrentLyrics() {
        const key = songGeneration + "|" + currentStream + "|" + currentTitle;
        if (lyricsInFlight.has(key)) return lyricsInFlight.get(key);
        const pending = resolveCurrentLyrics().finally(() => {
            if (lyricsInFlight.get(key) === pending) lyricsInFlight.delete(key);
        });
        lyricsInFlight.set(key, pending);
        return pending;
    }


    // ======================================================
    // YOUTUBE MUSIC VIDEO SEARCH
    // ======================================================

    function normalizeVideoText(value) {
        return String(value || "")
            .normalize("NFKD")
            .replace(/[\u0300-\u036f]/g, "")
            .toLowerCase()
            .replace(/&amp;/g, " and ")
            .replace(/&#39;/g, "'")
            .replace(/&quot;/g, "\"")
            .replace(/[^a-z0-9]+/g, " ")
            .replace(/\s+/g, " ")
            .trim();
    }

    // Require complete artist and song matches to reject similarly named tracks.
    function hasVideoPhrase(text, phrase) {
        return !!phrase && (" " + text + " ").includes(" " + phrase + " ");
    }

    function videoArtistMatches(title, channel, wantedArtist) {
        if (!wantedArtist) return false;

        if (hasVideoPhrase(title, wantedArtist) || hasVideoPhrase(channel, wantedArtist)) {
            return true;
        }

        // Channel labels often omit spaces, e.g. JamieFoxxVEVO.
        const compactArtist = wantedArtist.replace(/\s+/g, "");
        const compactChannel = channel.replace(/\s+/g, "");
        return compactArtist.length >= 6 && [
            compactArtist, compactArtist + "vevo",
            compactArtist + "topic", compactArtist + "official"
        ].includes(compactChannel);
    }

    function videoDurationSeconds(isoDuration) {
        const m = String(isoDuration || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
        if (!m) return null;
        return (Number(m[1] || 0) * 86400) +
            (Number(m[2] || 0) * 3600) +
            (Number(m[3] || 0) * 60) + Number(m[4] || 0);
    }

    function scoreYouTubeResult(item, artist, song) {
        if (!item || !item.snippet) return -1000;
        const title = normalizeVideoText(item.snippet.title);
        const channel = normalizeVideoText(item.snippet.channelTitle);
        const wantedArtist = normalizeVideoText(artist);
        const wantedSong = normalizeVideoText(removeFeaturedArtists(removeVersionInfo(song).replace(/\s*[([]\s*(?:\d{4}\s*)?(?:re-?master(?:ed)?|anniversary edition)(?:\s+version)?\s*[)\]]/gi, "")));
        // Radio remixes sometimes have an official music-video title without
        // the word "remix", but featuring the credited remix performers.
        const remixRadioTitle = /\bremix\b/.test(wantedSong);
        const baseSong = wantedSong.replace(/\s+remix\b/g, "").trim();
        const creditedRemixVideo = remixRadioTitle &&
            hasVideoPhrase(title, baseSong) &&
            /\b(feat|ft|featuring)\b/.test(title) &&
            /\b(official (music )?video|music video)\b/.test(title);
        if (!wantedArtist || !wantedSong ||
            (!hasVideoPhrase(title, wantedSong) && !creditedRemixVideo) ||
            !videoArtistMatches(title, channel, wantedArtist)) return -1000;

        // Reaction titles commonly quote "(Official Video)" despite being reactions.
        if (/\b(react|reacts|reacting|reaction|review|reviews|reviewing|breakdown|commentary|explained|podcast|interview|tutorial|karaoke|instrumental|cover|covers|parody|trailer|teaser|snippet|preview|fanmade|fan made|behind the scenes|making of|documentary|why|shares why|discusses|talks about)\b/.test(title)) return -1000;
        if (/\b(remix|mashup|sped up|slowed|nightcore|reverb)\b/.test(title) &&
            !/\b(remix|mashup|sped up|slowed|nightcore|reverb)\b/.test(normalizeVideoText(song))) return -1000;

        if (item.status && (item.status.embeddable === false ||
            item.status.privacyStatus === "private")) return -1000;
        const region = item.contentDetails && item.contentDetails.regionRestriction;
        if (region && ((Array.isArray(region.blocked) && region.blocked.includes("US")) ||
            (Array.isArray(region.allowed) && !region.allowed.includes("US")))) return -1000;

        let score = 260;
        const duration = videoDurationSeconds(item.contentDetails && item.contentDetails.duration);
        if (duration !== null) {
            if (duration < 85) score -= 170;
            if (duration > 800) score -= 160;
        }

        const compactArtist = wantedArtist.replace(/\s+/g, "");
        const compactChannel = channel.replace(/\s+/g, "");
        const officialChannel = channel === wantedArtist ||
            compactChannel === compactArtist ||
            compactChannel === compactArtist + "vevo" ||
            compactChannel === compactArtist + "official" ||
            compactChannel === compactArtist + "music";
        if (title.startsWith(wantedArtist + " " + wantedSong)) score += 55;
        // A title saying "Official Video" is not proof of official ownership.
        const declaresOfficial = /\bofficial (music )?video\b|\bofficial mv\b/.test(title);
        const artistChannel = officialChannel || hasVideoPhrase(channel, wantedArtist);
        if (declaresOfficial && artistChannel) score += 350;
        else if (declaresOfficial) score += 35;
        if (/\bofficial visualizer\b/.test(title)) score += 35;
        if (officialChannel) score += 360;
        // Ranking an unverified third-party music video is permitted, but an
        // artist/VEVO uploader remains strongly preferred when available.
        if (!artistChannel && explicitlyMusicVideo) score -= 130;
        if (/\bofficial (music )?video\b/.test(title) && officialChannel) score += 160;
        if (compactChannel === compactArtist + "vevo") score += 35;
        if (/\b(vevo|records|recordings|entertainment)\b/.test(channel)) score += 12;
        const explicitlyMusicVideo = /\b(official (music )?video|music video|official mv|video clip|hd video)\b/.test(title);
        // Without an attributable uploader, prefer no video over a false match.
        if (/\b(fan|news|reaction|reactions|karaoke|tribute|cover channel)\b/.test(channel)) return -1000;
        // Some genuine music videos are distributed by licensed archive and
        // entertainment uploaders. A matching title with clear video wording
        // can qualify even if the channel is not the artist's own channel.
        // It remains lower priority than a matching official artist/VEVO channel.
        if (!artistChannel && !/\b(vevo|records|recordings)\b/.test(channel) &&
            !explicitlyMusicVideo) return -1000;
        // Music-video evidence is mandatory; do not show interviews or unrelated
        // artist uploads merely because their description mentions the song.
        const musicVideoEvidence = /\b(official (music )?video|music video|official mv|vevo|hd video|video clip)\b/.test(title) ||
            (officialChannel && !/\b(live performance|performance|interview|rehearsal|teaser|audio)\b/.test(title));
        if (!musicVideoEvidence) return -1000;
        if (/\b(lyric video|lyrics|lyrics on screen)\b/.test(title)) score -= 135;
        // Reject explicitly audio-only uploads when selecting a music video.
        if (/\b(audio only|official audio|audio version|visual audio|audio)\b/.test(title) || /\btopic\b/.test(channel)) return -1000;
        if (/\b(audio|topic)\b/.test(title)) score -= 90;
        // Topic channels are auto-generated track audio, not official music videos.
        if (/\btopic\b/.test(channel)) score -= 260;
        if (/\bvisualizer\b/.test(title)) score -= 65;
        if (/\blive\b/.test(title)) score -= 95;

        // Actual views, not search position. View-count bonus is bounded
        // and only applies after both artist and song have been validated.
        const views = Number(item.statistics && item.statistics.viewCount);
        if (Number.isFinite(views) && views > 0) {
            score += Math.min(105, Math.round(Math.log10(views + 1) * 14));
        }
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

        const cacheKey = youtubeCacheKey(artist, song);

        // 1) Reuse any song we have already looked up.
        if (persistentVideoCache.has(cacheKey)) {
            const cached = persistentVideoCache.get(cacheKey);
            if (youtubeCacheValid(cached)) {
                if (!cached.found) {
                    console.log("YOUTUBE NEGATIVE CACHE HIT:", cacheKey);
                    return null;
                }
                const saved = cached.result;
                if (saved && scoreYouTubeResult({
                    snippet: { title: saved.videoTitle, channelTitle: saved.channelTitle }
                }, artist, song) > -1000) {
                    console.log("YOUTUBE VERIFIED CACHE HIT:", cacheKey);
                    return saved;
                }
                console.log("YOUTUBE REJECTED STALE WRONG MATCH:", cacheKey);
            }
            persistentVideoCache.delete(cacheKey);
            savePersistentVideoCache();
        }

        // 2) If another TV/browser is already searching this exact song,
        // wait for that same Promise instead of spending another 100 units.
        if (videoSearchesInProgress.has(cacheKey)) {
            console.log("YOUTUBE SEARCH ALREADY IN PROGRESS:", cacheKey);
            return await videoSearchesInProgress.get(cacheKey);
        }

        resetYoutubeDailyBudgetIfNeeded();

        if (Date.now() < youtubeSearchBackoffUntil) {
            const retryMinutes = Math.max(
                1,
                Math.ceil((youtubeSearchBackoffUntil - Date.now()) / 60000)
            );
            const error = new Error(
                `YouTube search paused to protect quota. Retry in about ${retryMinutes} minute(s).`
            );
            error.code = "YOUTUBE_BACKOFF";
            throw error;
        }

        if (!YOUTUBE_API_KEY) {
            throw new Error("YOUTUBE_API_KEY is not configured");
        }

        if (youtubeQuotaSpent + YOUTUBE_SEARCH_COST > YOUTUBE_DAILY_APP_BUDGET) {
            youtubeSearchBackoffUntil = nextUtcDayTimestamp();
            const error = new Error(
                "Slow Tide YouTube daily safety budget reached. Cached videos will continue playing."
            );
            error.code = "YOUTUBE_DAILY_BUDGET";
            throw error;
        }

        const searchPromise = (async () => {
            const cleanSong = removeVersionInfo(song)
                .replace(/\s*[([]\s*(?:\d{4}\s*)?(?:re-?master(?:ed)?|anniversary edition)(?:\s+version)?\s*[)\]]/gi, "")
                .trim();
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
                "&maxResults=35" +
                "&safeSearch=moderate" +
                "&regionCode=US" +
                "&q=" + encodeURIComponent(query) +
                "&key=" + encodeURIComponent(YOUTUBE_API_KEY);

            // Count before sending so simultaneous songs can never exceed
            // the application's own daily safety budget.
            youtubeQuotaSpent += YOUTUBE_SEARCH_COST;
            console.log(
                "YOUTUBE VIDEO SEARCH:",
                query,
                "| APP QUOTA:",
                youtubeQuotaSpent + "/" + YOUTUBE_DAILY_APP_BUDGET
            );

            try {
                const text = await fetchText(url, 10000);
                const data = JSON.parse(text);

                // Even an empty first result must continue to alternate searches.
                if (!data || !Array.isArray(data.items)) {
                    console.log("YOUTUBE FIRST SEARCH EMPTY:", query);
                }

                // An official-looking keyword query can still return only
                // automatically generated Topic audio. Search a second time
                // with the artist's VEVO/music-video wording before falling back.
                // Charge quota explicitly and never exceed the daily budget.
                const allSearchResults = Array.isArray(data && data.items) ? [...data.items] : [];
                const hasArtistVideo = items => items.some(item => {
                    if (!item || !item.snippet || !item.id || !item.id.videoId) return false;
                    const title = normalizeVideoText(item.snippet.title);
                    const channel = normalizeVideoText(item.snippet.channelTitle);
                    // A matched artist-channel video outranks Topic and audio uploads.
                    return scoreYouTubeResult(item, artist, song) >= 200 &&
                        !/\btopic\b/.test(channel) &&
                        !/\b(audio|reaction|review|interview|teaser)\b/.test(title);
                });
                if (!hasArtistVideo(allSearchResults) &&
                    youtubeQuotaSpent + YOUTUBE_SEARCH_COST <= YOUTUBE_DAILY_APP_BUDGET) {
                    const extraQuery = [artist, noFeature || cleanSong || song,
                        "VEVO official video"].filter(Boolean).join(" ");
                    const extraUrl = "https://www.googleapis.com/youtube/v3/search" +
                        "?part=snippet&type=video&maxResults=35" +
                                "&safeSearch=moderate&regionCode=US" +
                        "&q=" + encodeURIComponent(extraQuery) +
                        "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
                    youtubeQuotaSpent += YOUTUBE_SEARCH_COST;
                    console.log("YOUTUBE SECOND OFFICIAL SEARCH:", extraQuery,
                        "| APP QUOTA:", youtubeQuotaSpent + "/" + YOUTUBE_DAILY_APP_BUDGET);
                    try {
                        const extraData = JSON.parse(await fetchText(extraUrl, 10000));
                        if (Array.isArray(extraData.items)) {
                            const seen = new Set(allSearchResults.map(i => i.id && i.id.videoId));
                            for (const item of extraData.items) {
                                if (item.id && item.id.videoId && !seen.has(item.id.videoId)) {
                                    allSearchResults.push(item);
                                    seen.add(item.id.videoId);
                                }
                            }
                        }
                    } catch (error) {
                        console.log("YOUTUBE SECOND SEARCH UNAVAILABLE:", error.message);
                    }
                }

                // Last discovery attempt: original title without overly restrictive
                // "official"/"VEVO" qualifiers. Never play a bad result just because
                // the API did not return an official video.
                if (!hasArtistVideo(allSearchResults) &&
                    youtubeQuotaSpent + YOUTUBE_SEARCH_COST <= YOUTUBE_DAILY_APP_BUDGET) {
                    const broadenedSong = (noFeature || cleanSong || song || "")
                        .replace(/\s*[([]\s*remix\s*[)\]]/gi, "")
                        .trim();
                    const plainQuery = [artist, broadenedSong, "music video"]
                        .filter(Boolean).join(" ");
                    const plainUrl = "https://www.googleapis.com/youtube/v3/search" +
                        "?part=snippet&type=video&maxResults=35" +
                                "&safeSearch=moderate&regionCode=US" +
                        "&q=" + encodeURIComponent(plainQuery) +
                        "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
                    youtubeQuotaSpent += YOUTUBE_SEARCH_COST;
                    console.log("YOUTUBE BROADER VIDEO SEARCH:", plainQuery,
                        "| APP QUOTA:", youtubeQuotaSpent + "/" + YOUTUBE_DAILY_APP_BUDGET);
                    try {
                        const plainData = JSON.parse(await fetchText(plainUrl, 10000));
                        if (Array.isArray(plainData.items)) {
                            const seen = new Set(allSearchResults.map(i => i.id && i.id.videoId));
                            for (const item of plainData.items) {
                                if (item.id && item.id.videoId && !seen.has(item.id.videoId)) {
                                    allSearchResults.push(item);
                                    seen.add(item.id.videoId);
                                }
                            }
                        }
                    } catch (error) {
                        console.log("YOUTUBE BROADER SEARCH UNAVAILABLE:", error.message);
                    }
                }

                // search.list has no view statistics. One videos.list lookup
                // supplies real view counts and embed status for candidates.
                const candidates = allSearchResults.filter(item =>
                    item && item.id && item.id.videoId &&
                    scoreYouTubeResult(item, artist, song) > -1000);
                console.log("YOUTUBE CANDIDATE AUDIT:", allSearchResults.length, "search results;", candidates.length, "matching metadata and uploaders");
                let detailedCandidates = candidates;
                if (candidates.length) {
                    const ids = candidates.slice().sort((a, b) =>
                        scoreYouTubeResult(b, artist, song) - scoreYouTubeResult(a, artist, song))
                        .slice(0, 50).map(item => item.id.videoId);
                    const detailUrl = "https://www.googleapis.com/youtube/v3/videos" +
                        "?part=statistics,contentDetails,status" +
                        "&id=" + encodeURIComponent(ids.join(",")) +
                        "&key=" + encodeURIComponent(YOUTUBE_API_KEY);
                    try {
                        const detailData = JSON.parse(await fetchText(detailUrl, 10000));
                        if (Array.isArray(detailData.items)) {
                            const detailMap = new Map(detailData.items.map(d => [d.id, d]));
                            detailedCandidates = candidates.filter(item =>
                                detailMap.has(item.id.videoId)).map(item => ({
                                    ...detailMap.get(item.id.videoId),
                                    snippet: item.snippet,
                                    id: item.id
                                }));
                            console.log("YOUTUBE VIDEO DETAILS:", detailedCandidates.length,
                                "candidates ranked with view counts");
                        }
                    } catch (error) {
                        console.log("YOUTUBE VIDEO STATS UNAVAILABLE:", error.message);
                    }
                }
                let best = null;
                let bestScore = -1000;
                for (const item of detailedCandidates) {
                    const score = scoreYouTubeResult(item, artist, song);
                    if (score > bestScore) {
                        bestScore = score;
                        best = item;
                    }
                }

                if (!best) {
                    persistentVideoCache.set(cacheKey, {
                        found: false,
                        result: null,
                        query: query,
                        selectionVersion: YOUTUBE_CACHE_SELECTION_VERSION,
                        cachedAt: Date.now()
                    });
                    savePersistentVideoCache();
                    return null;
                }

                const thumbs = best.snippet.thumbnails || {};
                const thumb = thumbs.high || thumbs.medium || thumbs.default || null;

                const result = {
                    videoId: best.id.videoId,
                    videoTitle: decodeText(best.snippet.title),
                    channelTitle: decodeText(best.snippet.channelTitle),
                    thumbnail: thumb ? thumb.url : null,
                    score: bestScore,
                    viewCount: best.statistics && best.statistics.viewCount
                        ? Number(best.statistics.viewCount) : null,
                    query: query
                };

                persistentVideoCache.set(cacheKey, {
                    found: true,
                    result: result,
                    selectionVersion: YOUTUBE_CACHE_SELECTION_VERSION,
                    cachedAt: Date.now()
                });
                savePersistentVideoCache();

                console.log("YOUTUBE VIDEO MATCH:", best.snippet.title,
                    "| CHANNEL:", best.snippet.channelTitle,
                    "| VIEWS:", result.viewCount,
                    "| SCORE:", bestScore, "| SAVED:", cacheKey);

                return result;
            } catch (error) {
                const message = String(error.message || "");
                const quotaProblem =
                    /HTTP\s*(403|429)/i.test(message) ||
                    /quota/i.test(message);

                if (quotaProblem) {
                    youtubeSearchBackoffUntil = nextUtcDayTimestamp();
                    console.log(
                        "YOUTUBE QUOTA PROTECTION UNTIL:",
                        new Date(youtubeSearchBackoffUntil).toISOString()
                    );
                }

                throw error;
            }
        })();

        videoSearchesInProgress.set(cacheKey, searchPromise);

        try {
            return await searchPromise;
        } finally {
            videoSearchesInProgress.delete(cacheKey);
        }
    }

    // Video lookups run once per track in the background. The API itself must
    // respond immediately so the TV can clear the previous track promptly.
    // Captured songGeneration guards against slow, out-of-order YouTube results.
    function buildVideoReply(result) {
        return {
            ...result,
            songGeneration: songGeneration,
            songStartedAt: songStartedAt,
            songElapsedSeconds: Math.max(0, (Date.now() - songStartedAt) / 1000)
        };
    }

    function getCurrentMusicVideo() {
        const title = currentTitle;
        const generation = songGeneration;
        const streamAtRequest = currentStream;

        if (
            !title ||
            title === "Connecting to Slow Tide..." ||
            title === "Connecting to new station..." ||
            title === "Waiting for song information..."
        ) {
            return buildVideoReply({
                success: false,
                status: "waiting",
                title: title,
                message: "Waiting for song information."
            });
        }

        // Normal reads are instantaneous; no new YouTube API call is made.
        if (videoCache.title === title &&
            videoCache.generation === generation &&
            videoCache.result) {
            const cached = videoCache.result;
            // Retry temporary network/API errors, but respect quota backoff.
            const retryable = cached.status === "error" &&
                Date.now() - videoCache.updated > 90000;
            const quotaReady = cached.status === "quota_wait" &&
                Date.now() >= youtubeSearchBackoffUntil;
            const unavailableRetry = cached.status === "unavailable" &&
                Date.now() - videoCache.updated > 15 * 60 * 1000;
            if (!retryable && !quotaReady && !unavailableRetry) return buildVideoReply(cached);
        }

        const info = splitArtistAndSong(title);
        if (!info.artist || !info.song) {
            const unavailable = {
                success: false,
                status: "unavailable",
                title: title,
                artist: info.artist,
                song: info.song,
                message: "Waiting for complete artist and song metadata."
            };
            videoCache = { title, generation, result: unavailable, updated: Date.now() };
            return buildVideoReply(unavailable);
        }

        const pending = {
            success: false,
            status: "searching",
            title: title,
            artist: info.artist,
            song: info.song,
            message: "Finding a matching music video..."
        };
        videoCache = { title, generation, result: pending, updated: Date.now() };

        function stillCurrent() {
            return songGeneration === generation &&
                currentTitle === title && currentStream === streamAtRequest;
        }

        // The one search is shared by all TVs; late results cannot restore
        // a previous track after the radio has moved to the next song.
        searchYouTubeMusicVideo(info.artist, info.song).then(match => {
            if (!stillCurrent()) {
                console.log("YOUTUBE STALE LOOKUP DISCARDED:", title);
                return;
            }

            const result = !match ? {
                success: false,
                status: "unavailable",
                title: title,
                artist: info.artist,
                song: info.song,
                message: "No matching embeddable music video found.",
                source: "YouTube"
            } : {
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
                viewCount: match.viewCount || null,
                source: "YouTube",
                muted: true
            };

            videoCache = { title, generation, result, updated: Date.now() };
            console.log("YOUTUBE VIDEO STATUS:", title, "=>", result.status);
        }).catch(error => {
            if (!stillCurrent()) {
                console.log("YOUTUBE STALE ERROR DISCARDED:", title);
                return;
            }
            console.log("YOUTUBE VIDEO ERROR:", error.message);
            const errorCode = error.code || "";
            const isQuotaWait =
                errorCode === "YOUTUBE_BACKOFF" ||
                errorCode === "YOUTUBE_DAILY_BUDGET" ||
                /HTTP\s*(403|429)/i.test(String(error.message || "")) ||
                /quota/i.test(String(error.message || ""));

            if (isQuotaWait && Date.now() >= youtubeSearchBackoffUntil) {
                youtubeSearchBackoffUntil = nextUtcDayTimestamp();
            }
            const failure = {
                success: false,
                status: isQuotaWait ? "quota_wait" : "error",
                title: title,
                artist: info.artist,
                song: info.song,
                message: isQuotaWait
                    ? "YouTube search is paused to protect quota. Cached videos continue to work."
                    : "Video search temporarily unavailable; retrying automatically.",
                source: "YouTube",
                retryAfterSeconds: isQuotaWait
                    ? Math.max(1, Math.ceil((youtubeSearchBackoffUntil - Date.now()) / 1000))
                    : 90
            };
            videoCache = { title, generation, result: failure, updated: Date.now() };
        });

        return buildVideoReply(pending);
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

                syncCompensationSeconds:
                    MASTER_SYNC_COMPENSATION_SECONDS,

                autoSyncMethod:
                    autoSyncMethod,

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
                pendingRadioTitle = null;
                pendingRadioTitleCount = 0;
                pendingRadioTitleStream = null;

                // Immediately invalidate all async work from the old station.
                songGeneration++;

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

                videoCache = {
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


// ============================================================
// SLOW TIDE - PUBLIC PRIVACY POLICY
// Google / YouTube Data API compliance page.
// Does not change karaoke synchronization.
// ============================================================
app.get("/privacy", (req, res) => {
    res.type("html").send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Slow Tide Privacy Policy</title>
<style>
body{font-family:Arial,sans-serif;max-width:850px;margin:40px auto;padding:0 22px;line-height:1.65;background:#07121f;color:#f5f7fb}
h1,h2{color:#fff} a{color:#8fd8ff}
.card{background:#0d2033;padding:28px;border-radius:16px}
.small{opacity:.8}
</style>
</head>
<body><div class="card">
<h1>Slow Tide Privacy Policy</h1>
<p class="small">Last updated: October 24, 2026</p>

<p>Slow Tide is a music entertainment experience presented by Da Obsidian Court. Slow Tide uses YouTube API Services to locate relevant music videos corresponding to songs playing through the Slow Tide radio experience and may display those videos using YouTube's embedded player.</p>

<h2>Information We Process</h2>
<p>Slow Tide does not require users to create an account or provide personal information in order to use the music-video display. The application may process technical information normally transmitted when a user accesses a web service, such as basic request and server log information.</p>

<h2>YouTube API Services</h2>
<p>Slow Tide uses YouTube API Services. Use of YouTube features is also subject to the YouTube Terms of Service and Google's Privacy Policy.</p>
<p><a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a></p>
<p><a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a></p>

<h2>How YouTube Data Is Used</h2>
<p>The application uses current radio song metadata to search for relevant YouTube music videos. It may retain video IDs, titles, channel names, thumbnails, search queries and match scores in server-side memory and a local cache file to reduce API requests. Cached entries are discarded after 30 days and refreshed through a new API search when needed, subject to API quota limits. Expired entries are removed when the cache is loaded or accessed. Server restarts or temporary storage may delete entries earlier. No YouTube videos are downloaded or hosted by Slow Tide.</p>
<h2>Cookies, Browser Storage and Third Parties</h2>
<p>Slow Tide web pages may use browser storage to maintain display preferences or playback state. When YouTube videos are embedded, Google/YouTube may collect device identifiers, IP address, browser information, usage data and cookies or similar technologies under their own policies. Browser settings may allow visitors to restrict cookies or clear stored data. Hosting providers may process IP addresses and technical logs needed to deliver and protect the service.</p>
<h2>Retention and Choices</h2>
<p>Song-to-video search metadata is kept for up to 30 days in the application cache; it is not a user viewing history. Visitors can stop using the embedded player and manage YouTube-related cookies through their browser and Google privacy controls.</p>

<h2>Data Sharing</h2>
<p>Slow Tide does not sell personal information. Information may be transmitted to service providers necessary to operate the application, including hosting services and YouTube/Google services when YouTube features are used.</p>

<h2>Changes to This Policy</h2>
<p>This policy may be updated when Slow Tide's features or data practices change. The current version will remain available at this URL.</p>

<h2>Contact</h2>
<p>For privacy questions, data requests, or support, email <a href="mailto:daprecha@hotmail.com">daprecha@hotmail.com</a>.</p>
</div></body></html>`);
});


// ============================================================
// SLOW TIDE - TERMS OF SERVICE
// Public compliance page. Does not affect the TV or karaoke.
// ============================================================
app.get("/terms", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Slow Tide Terms of Service</title>
<style>
body{font-family:Arial,sans-serif;max-width:850px;margin:40px auto;padding:0 22px;line-height:1.65;background:#06101d;color:#f5f7fb}
h1,h2{color:#fff}a{color:#75dcff}.card{background:#0d2033;padding:28px;border-radius:16px}
</style></head><body><div class="card">
<h1>Slow Tide Terms of Service</h1>
<p>Last updated: October 5, 2026</p>
<p>Slow Tide is a music entertainment experience presented by Da Obsidian Court. By accessing Slow Tide web features, you agree to use them only for their intended entertainment purpose.</p>
<h2>YouTube Services</h2>
<p>Slow Tide may use YouTube API Services to locate and display relevant YouTube videos. Use of YouTube features is subject to the <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a> and applicable Google policies.</p>
<h2>Availability</h2>
<p>Features may be changed, interrupted, limited, or unavailable due to third-party services, API limits, maintenance, or technical conditions.</p>
<h2>Content</h2>
<p>YouTube videos remain hosted and delivered by YouTube. Slow Tide does not claim ownership of third-party YouTube content.</p>
<h2>Privacy</h2>
<p>See the <a href="/privacy">Slow Tide Privacy Policy</a> for information about data practices and use of YouTube API Services.</p>
<h2>Contact</h2>
<p>For support or questions, email <a href="mailto:daprecha@hotmail.com">daprecha@hotmail.com</a>.</p>
</div></body></html>`);
});

// ============================================================
// SLOW TIDE - YOUTUBE API COMPLIANCE / REVIEW PAGE
// Separate from the in-world video TV.
// ============================================================
app.get("/youtube-compliance", (req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Slow Tide - YouTube API Integration</title>
<style>
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:linear-gradient(135deg,#08051a,#061d31);color:#f7fbff}
main{max-width:1050px;margin:auto;padding:42px 24px 60px}.brand{text-align:center;margin-bottom:28px}
h1{font-size:54px;margin:0;color:#fff;text-shadow:0 0 20px #ff4aa2}h2{margin-top:0}.tag{color:#79eaff;letter-spacing:3px}
.card{background:rgba(8,20,38,.92);border:1px solid #1c6c87;border-radius:18px;padding:26px;margin-top:22px}
.player{position:relative;padding-top:56.25%;overflow:hidden;border-radius:14px;background:#000}
.player iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
.links{text-align:center;margin-top:28px;font-size:18px}.links a{color:#86eaff;margin:0 12px}
.note{color:#cbd9e6;line-height:1.65}.yt{font-weight:bold;color:#fff}
</style></head><body><main>
<div class="brand"><h1>Slow Tide</h1><p class="tag">MUSIC • VIDEO • R&amp;B EXPERIENCE</p></div>
<div class="card">
<h2>YouTube API Integration</h2>
<p class="note"><strong>Google Cloud project:</strong> 302460013074. This is the only Google Cloud project used by the Slow Tide operator for this integration. Song lyrics are obtained separately through LRCLIB and do not use the YouTube Data API.</p>
<p class="note">Slow Tide uses the YouTube Data API to search for an appropriate YouTube music video corresponding to the song currently playing through the Slow Tide radio experience. Videos are displayed using the YouTube embedded player. Slow Tide does not download or redistribute YouTube videos.</p>
</div>
<div class="card">
<h2 class="yt">YouTube Embedded Player</h2>
<div class="player">
<iframe src="https://www.youtube.com/embed/DHpUtOcwhyU?rel=0" title="YouTube video player" allow="accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
</div>
<p class="note">The embedded player above features Ginuwine - "So Anxious" and demonstrates the same YouTube embedded-player technology used by the Slow Tide music-video feature.</p>
</div>
<div class="links">
<a href="/privacy">Privacy Policy</a> |
<a href="/terms">Terms of Service</a> |
<a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">YouTube Terms of Service</a> |
<a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer">Google Privacy Policy</a>
</div>
</main></body></html>`);
});


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


            // Check radio metadata every 2 seconds; YouTube lookups run
            // separately so music-video searches never block song detection.
            setInterval(
                updateNowPlaying,
                2000
            );
        }
    );
