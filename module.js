/*
 * Sora module for a Naruto fanfiction hosted as a PixelDrain shared folder.
 *
 * Folder layout on PixelDrain (fixed, per the user's description):
 *   /d/CEG3sGRE/
 *     Season 1/
 *       Episode 1.mp4
 *       Episode 2.mp4
 *       ...
 *     Season 2/
 *       ...
 *
 * This module has exactly one "series": the fanfic itself. There's nothing
 * to actually search across, so searchResults() just returns that single
 * series whenever the query isn't empty. extractEpisodes() walks the
 * PixelDrain folder tree (season folders -> episode files) and flattens it
 * into one numbered episode list, prefixing each title with its season so
 * users can still tell seasons apart in Sora's episode list UI.
 *
 * PixelDrain API used (public, no API key required for public folders):
 *   GET https://pixeldrain.com/api/filesystem/{id}?stat
 *     -> { path: [...], base_index, children: [ { type: "dir"|"file", name, id, path }, ... ] }
 *   GET https://pixeldrain.com/api/file/{id}
 *     -> direct, playable file stream (works for MP4 playback)
 */

// The PixelDrain folder ID from https://pixeldrain.net/d/CEG3sGRE
const ROOT_FOLDER_ID = "CEG3sGRE";

// Title shown to the user in search results / details.
const SERIES_TITLE = "My Naruto Fanfiction";

// Helper: build the PixelDrain "stat" API URL for any file/folder id.
function statUrl(id) {
    return `https://pixeldrain.com/api/filesystem/${id}?stat`;
}

// Helper: build the direct playable stream URL for a PixelDrain file id.
function fileStreamUrl(id) {
    return `https://pixeldrain.com/api/file/${id}`;
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
 * Walks the root folder's children. Each child directory is treated as a
 * season; each file inside that season directory is treated as an episode.
 * Episodes are flattened into one continuous numbered list (Season 1's
 * episodes first, then Season 2's, etc.), since Sora's episode model is
 * a single flat list rather than a season/episode grid.
 *
 * Each episode's href directly encodes the PixelDrain file stream URL,
 * so extractStreamUrl() doesn't need to make another request.
 */
async function extractEpisodes(url) {
    try {
        const rootId = url;
        const rootResponse = await fetchv2(statUrl(rootId));
        const rootData = await rootResponse.json();

        // children of the root folder = season folders
        const seasonDirs = (rootData.children || [])
            .filter(child => child.type === "dir")
            // Sort seasons by name so "Season 2" doesn't come before "Season 1" etc.
            .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

        const episodes = [];
        let episodeCounter = 1;

        for (const season of seasonDirs) {
            const seasonResponse = await fetchv2(statUrl(season.id));
            const seasonData = await seasonResponse.json();

            const episodeFiles = (seasonData.children || [])
                .filter(child => child.type === "file")
                // Sort episodes within a season naturally (Episode 2 before Episode 10)
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

            for (const file of episodeFiles) {
                episodes.push({
                    // Directly store the playable stream URL as the href.
                    href: fileStreamUrl(file.id),
                    number: String(episodeCounter)
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
 * Input: href returned from extractEpisodes (already a PixelDrain file stream URL)
 * Output: direct stream URL (string)
 *
 * Because extractEpisodes() already builds the final PixelDrain file
 * stream URL, this function just needs to hand it back. It's kept as a
 * real async function (rather than a passthrough) so it stays consistent
 * with Sora's async mode and is easy to extend later if PixelDrain ever
 * requires resolving a redirect first.
 */
async function extractStreamUrl(url) {
    try {
        // url is already "https://pixeldrain.com/api/file/{id}" from extractEpisodes.
        return url;
    } catch (error) {
        console.log("extractStreamUrl error:", error);
        return null;
    }
}
