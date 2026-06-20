/*
 * Sora module for a Naruto fanfiction hosted as a PixelDrain shared folder.
 *
 * Real PixelDrain filesystem API shape (confirmed against PixelDrain's own
 * TypeScript client and the gallery-dl extractor, since the API has no
 * official public docs page):
 *
 *   GET https://pixeldrain.com/api/filesystem/{path}?stat
 *     -> {
 *          path: [ { type, path, name, ... }, ... ],  // breadcrumb, root -> target
 *          base_index: N,                              // index of target within `path`
 *          children: [ { type: "dir"|"file", path, name, file_size, ... }, ... ]
 *        }
 *
 * IMPORTANT: {path} is the actual filesystem path (e.g.
 * "CEG3sGRE/Land of Waves/Episode 1.mp4"), NOT a per-file short ID. However,
 * each child's "path" field in the API response is RELATIVE to the
 * directory you requested (e.g. "/Land of Waves", with a leading slash),
 * not an absolute path you can call directly. This module always builds
 * full paths itself by concatenating the parent's full path with each
 * child's relative path before making the next request.
 *
 * Folder layout on PixelDrain (per the user's actual folder):
 *   /d/CEG3sGRE/
 *     Land of Waves/
 *       <episode files>
 *     Chūnin Exams/
 *       <episode files>
 *     Search for Tsunade/
 *     Sasuke Retrieval Mission/
 *     Kakashi Chronicles/
 *     Kazekage Rescue Mission/
 *     Tenchi Bridge Mission/
 *     Akatsuki Suppression Mission/
 *     Itachi Pursuit Mission/
 *
 * This module has exactly one "series": the fanfic itself. searchResults()
 * just returns that single series for any non-empty query. extractEpisodes()
 * walks the season folders in a fixed, in-story order (NOT alphabetical --
 * "Land of Waves" comes before "Chūnin Exams" in the story, but not in the
 * alphabet) and flattens all episodes into one continuous numbered list,
 * prefixing each title with its season name.
 */

// The PixelDrain folder ID from https://pixeldrain.net/d/CEG3sGRE
const ROOT_FOLDER_ID = "CEG3sGRE";

// Title shown to the user in search results / details.
const SERIES_TITLE = "My Naruto Fanfiction";

// Season folder names, in the order they should appear (story order, not
// alphabetical -- PixelDrain's API does not guarantee folder ordering).
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

// Helper: build the PixelDrain "stat" API URL for any filesystem path.
// `path` should NOT have a leading slash (e.g. "CEG3sGRE/Land of Waves").
function statUrl(path) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `https://pixeldrain.com/api/filesystem/${encoded}?stat`;
}

// Helper: build the direct playable stream URL for a PixelDrain filesystem path.
function fileStreamUrl(path) {
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `https://pixeldrain.com/api/filesystem/${encoded}`;
}

/**
 * searchResults(keyword)
 * Input: search keyword (string)
 * Output: JSON string array of { title, image, href }
 *
 * Since this module only ever serves one series, any non-empty search
 * just returns that series. The "href" is the series' own PixelDrain
 * folder id so extractDetails/extractEpisodes know where to look.
 */
async function searchResults(keyword) {
    try {
        const results = [{
            title: SERIES_TITLE,
            image: "", // PixelDrain folders have no cover art; left blank.
            href: ROOT_FOLDER_ID
        }];
        return JSON.stringify(results);
    } catch (error) {
        console.log("searchResults error:", error);
        return JSON.stringify([]);
    }
}

/**
 * extractDetails(url)
 * Input: href returned from searchResults (the root folder id)
 * Output: JSON string array of { description, aliases, airdate }
 *
 * Kept minimal since there's no metadata source beyond the folder itself.
 */
async function extractDetails(url) {
    try {
        const details = [{
            description: "A Naruto fanfiction, hosted as a PixelDrain folder. Each subfolder is a season; each file inside is an episode.",
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
 * Input: href returned from searchResults (the root folder id)
 * Output: JSON string array of { href, number }
 *
 * Looks up each season name from SEASON_ORDER inside the root folder's
 * children, then lists the files inside that season folder as episodes.
 * Episodes are flattened into one continuous numbered list across all
 * seasons, since Sora's episode model is a single flat list rather than a
 * season/episode grid. Each episode's href stores the file's PixelDrain
 * filesystem path; extractStreamUrl() turns that into the playable URL.
 */
async function extractEpisodes(url) {
    try {
        // url is the root folder id (e.g. "CEG3sGRE") as returned by searchResults.
        // Some APIs (PixelDrain included) behave differently or redirect
        // requests that don't look like they're coming from a browser, so a
        // User-Agent header is sent explicitly here.
        const rootResponse = await fetchv2(
            statUrl(ROOT_FOLDER_ID),
            { "User-Agent": "Mozilla/5.0 (compatible; SoraModule/1.0)" }
        );
        const rootData = await rootResponse.json();

        // children of the root folder = season folders. Per PixelDrain's API,
        // each child's "path" field is RELATIVE to the requested directory
        // (e.g. "/Land of Waves"), not a full path usable on its own. We build
        // the full path ourselves: ROOT_FOLDER_ID + child's relative path.
        const allChildren = rootData.children || [];

        // Fail fast and loud if the root call didn't actually return any
        // children -- this means the request itself failed (auth, redirect,
        // wrong URL, etc.), and there is no point trying all 9 seasons one
        // by one, since they would all fail the same way.
        if (allChildren.length === 0) {
            console.log("extractEpisodes: root folder returned no children. Root response was:", JSON.stringify(rootData));
            return JSON.stringify([]);
        }

        const episodes = [];
        let episodeCounter = 1;

        for (const seasonName of SEASON_ORDER) {
            const seasonDir = allChildren.find(
                child => child.type === "dir" && child.name === seasonName
            );
            // Skip silently if a season folder is missing/renamed on PixelDrain --
            // keeps the module from breaking entirely over one mismatched name.
            if (!seasonDir) {
                console.log(`Season folder not found: ${seasonName}`);
                continue;
            }

            // Build the full path: "CEG3sGRE" + "/Land of Waves" -> "CEG3sGRE/Land of Waves"
            const seasonFullPath = `${ROOT_FOLDER_ID}${seasonDir.path}`;
            const seasonResponse = await fetchv2(
                statUrl(seasonFullPath),
                { "User-Agent": "Mozilla/5.0 (compatible; SoraModule/1.0)" }
            );
            const seasonData = await seasonResponse.json();

            const episodeFiles = (seasonData.children || [])
                .filter(child => child.type === "file")
                // PixelDrain filesystems can contain a hidden search-index
                // file; make sure it never shows up as a fake episode.
                .filter(child => child.name !== ".search_index.gz")
                // Sort episodes within a season naturally (Episode 2 before Episode 10)
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

            for (const file of episodeFiles) {
                // Again, file.path is relative to seasonFullPath -- prefix it
                // to get the real, full filesystem path to the episode file.
                const fileFullPath = `${seasonFullPath}${file.path}`;
                episodes.push({
                    href: fileFullPath,
                    number: String(episodeCounter),
                    // Prefix with season name since Sora shows episodes as one
                    // flat list with no separate season grouping in the UI.
                    title: `${seasonName} - ${file.name}`
                });
                episodeCounter++;
            }
        }

        return JSON.stringify(episodes);
    } catch (error) {
        console.log("extractEpisodes error:", error);
        return JSON.stringify([]);
    }
}

/**
 * extractStreamUrl(url)
 * Input: href returned from extractEpisodes (a PixelDrain filesystem path,
 *        e.g. "CEG3sGRE/Land of Waves/Episode 1.mp4")
 * Output: direct stream URL (string)
 *
 * Builds the actual playable URL from the stored filesystem path. PixelDrain
 * serves filesystem files for direct playback at:
 *   https://pixeldrain.com/api/filesystem/{url-encoded-path}
 * This works for public files without an API key.
 */
async function extractStreamUrl(url) {
    try {
        // url is the file's filesystem path, e.g. "CEG3sGRE/Land of Waves/Episode 1.mp4".
        return fileStreamUrl(url);
    } catch (error) {
        console.log("extractStreamUrl error:", error);
        return null;
    }
}
