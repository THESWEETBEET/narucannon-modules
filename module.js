/*
 * Sora module for a Naruto fanfiction hosted as a PixelDrain shared folder.
 *
 * Folder layout on PixelDrain:
 *   /d/CEG3sGRE/
 *     Land of Waves/              <- a season folder
 *       <episode files>
 *     Chūnin Exams/
 *       <episode files>
 *     ... (7 more season folders, listed in SEASON_ORDER below)
 *
 * UX behavior (per explicit request): searching for a SEASON NAME (e.g.
 * "Land of Waves") returns that season directly as a single search result.
 * Selecting it goes straight to that season's episode list. There is no
 * separate "series" page in between -- each season IS a result.
 *
 * Root cause of the earlier bug: fetchv2() in Sora takes FOUR positional
 * arguments -- (url, headers, method, body) -- not (url, optionsObject).
 * Calling it with the wrong shape was the actual reason every request
 * appeared to fail with "Redirect value is true" before this fix.
 * This module copies the exact known-working fetchv2 call pattern used by
 * the existing "One Pace" PixelDrain module.
 */

// The PixelDrain folder ID from https://pixeldrain.net/d/CEG3sGRE
const ROOT_FOLDER_ID = "CEG3sGRE";

// Season folder names, in story order (used only for an episode-number
// fallback; matching against PixelDrain itself is done by exact name).
const SEASON_ORDER = [
    "Land of Waves",
    "Chūnin Exams",
    "Search for Tsunade",
    "Sasuke Retrieval Mission",
    "Kakashi Chronicles",
    "Kazekage Rescue Mission",
    "Tenchi Bridge Mission",
    "Akatsuki Suppression Mission",
    "Itachi Pursuit Mission"
];

// Correct fetchv2 wrapper -- matches the verified-working call signature:
// fetchv2(url, headers, method, body). DO NOT pass a single options object;
// that silently breaks the request in Sora's runtime.
async function soraFetch(url, headers = {}, method = "GET", body = null) {
    try {
        return await fetchv2(url, headers, method, body);
    } catch (e) {
        try {
            return await fetch(url, { headers, method, body });
        } catch (error) {
            console.log("soraFetch failed for", url, error);
            return null;
        }
    }
}

// Helper: build the PixelDrain "stat" API URL for any filesystem path.
// IMPORTANT: do NOT manually encodeURIComponent here -- fetchv2 appears to
// already encode the URL itself, so pre-encoding caused a double-encoding
// bug (spaces became %2520 instead of %20). Pass the path through as-is.
function statUrl(path) {
    return `https://pixeldrain.com/api/filesystem/${path}?stat`;
}

/**
 * searchResults(keyword)
 * Input: search keyword (string)
 * Output: JSON string array of { title, image, href }
 *
 * Fetches the root folder once, then returns one result PER SEASON whose
 * name contains the keyword (case-insensitive). Each result's href is the
 * season's full PixelDrain path, so selecting it goes straight to that
 * season's episode list via extractEpisodes.
 */
async function searchResults(keyword) {
    try {
        const response = await soraFetch(statUrl(ROOT_FOLDER_ID));
        if (!response) {
            console.log("searchResults: root fetch returned null");
            return JSON.stringify([]);
        }

        const rootText = await response.text();
        let rootData;
        try {
            rootData = JSON.parse(rootText);
        } catch (parseErr) {
            console.log("searchResults: root response was not valid JSON:", rootText.slice(0, 500));
            return JSON.stringify([]);
        }

        const allChildren = rootData.children || [];
        const seasonDirs = allChildren.filter(child => child.type === "dir");

        const lowerKeyword = (keyword || "").toLowerCase();

        const results = seasonDirs
            .filter(season => !lowerKeyword || season.name.toLowerCase().includes(lowerKeyword))
            .map(season => ({
                title: season.name,
                image: "",
                // season.path is already the FULL path (e.g. "CEG3sGRE/1 - Land of
                // Waves"), confirmed from live debug logs -- do NOT prepend
                // ROOT_FOLDER_ID again, that was the earlier double-prefix bug.
                href: season.path.startsWith("/") ? season.path.slice(1) : season.path
            }));

        console.log(`searchResults: ${results.length} season(s) matched "${keyword}"`);
        return JSON.stringify(results);
    } catch (error) {
        console.log("searchResults error:", error);
        return JSON.stringify([]);
    }
}

/**
 * extractDetails(url)
 * Input: href returned from searchResults (a season's full PixelDrain path)
 * Output: JSON string array of { description, aliases, airdate }
 */
async function extractDetails(url) {
    try {
        const details = [{
            description: "A Naruto fanfiction, hosted as a PixelDrain folder.",
            aliases: "N/A",
            airdate: "N/A"
        }];
        return JSON.stringify(details);
    } catch (error) {
        console.log("extractDetails error:", error);
        return JSON.stringify([{
            description: "No description available",
            aliases: "N/A",
            airdate: "N/A"
        }]);
    }
}

/**
 * extractEpisodes(url)
 * Input: href returned from searchResults (a season's full PixelDrain path,
 *        e.g. "CEG3sGRE/Land of Waves")
 * Output: JSON string array of { href, number }
 *
 * Stats the season folder directly and lists its files as episodes.
 */
async function extractEpisodes(url) {
    try {
        const response = await soraFetch(statUrl(url));
        if (!response) {
            console.log("extractEpisodes: season fetch returned null for", url);
            return JSON.stringify([]);
        }

        const seasonText = await response.text();
        let seasonData;
        try {
            seasonData = JSON.parse(seasonText);
        } catch (parseErr) {
            console.log("extractEpisodes: season response was not valid JSON:", seasonText.slice(0, 500));
            return JSON.stringify([]);
        }

        const episodeFiles = (seasonData.children || [])
            .filter(child => child.type === "file")
            .filter(child => child.name !== ".search_index.gz")
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        if (episodeFiles.length > 0) {
            console.log("extractEpisodes: sample file.path =", episodeFiles[0].path, "| file.name =", episodeFiles[0].name);
        } else {
            console.log("extractEpisodes: season folder had zero file-type children. Raw children:", JSON.stringify(seasonData.children));
        }

        // Build each episode's href from file.path, but verify the
        // assumption rather than blindly trust it: if file.path already
        // contains the root folder ID, it's a full absolute path -- use it
        // as-is. If not, it's relative to the season -- prefix it with the
        // season's path (`url`). This avoids re-guessing wrong a third time.
        const episodes = episodeFiles.map((file, index) => {
            const rawPath = file.path.startsWith("/") ? file.path.slice(1) : file.path;
            const isAbsolute = rawPath.startsWith(ROOT_FOLDER_ID);
            const href = isAbsolute ? rawPath : `${url}/${file.name}`;
            return { href, number: index + 1 };
        });

        console.log(`extractEpisodes: ${episodes.length} episode(s) found for ${url}`);
        return JSON.stringify(episodes);
    } catch (error) {
        console.log("extractEpisodes error:", error);
        return JSON.stringify([]);
    }
}

/**
 * extractStreamUrl(url)
 * Input: href returned from extractEpisodes (file.path from PixelDrain,
 *        already a complete, correctly-encoded absolute path)
 * Output: direct stream URL (string)
 *
 * No manual encoding here -- url is already in the correct, ready-to-use
 * form straight from PixelDrain's API.
 */
async function extractStreamUrl(url) {
    try {
        return `https://pixeldrain.com/api/filesystem/${url}`;
    } catch (error) {
        console.log("extractStreamUrl error:", error);
        return null;
    }
}
