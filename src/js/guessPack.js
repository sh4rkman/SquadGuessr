import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { validGuess } from "../../server/validate.js";
import { findMap } from "./data/maps.js";

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const MODES = ["easy", "hard"];
const MAX_JSON = 1024 * 1024;
// full-size PNG screenshots (4K included) still fit; the review turns them into 900×900 webp on export
export const MAX_IMAGE = 32 * 1024 * 1024;
// all images one ZIP may unpack to together: a stranger's ZIP must not exhaust the review tab's memory
export const MAX_TOTAL = 512 * 1024 * 1024;
// the .json file may have any name; compressing the unpacked folder again puts everything one level deeper
// ("squadguessr-Dan-2026-10-06/guesses.json")
const JSON_PATH = /^(?:[^/]+\/)?[^/]+\.json$/i;
const IMAGE_PATH = /^(?:[^/]+\/)?img\/guesses\/[^/]+\.(?:webp|png|jpe?g)$/i;
// macOS adds resource forks ("._name", "__MACOSX/…") when it compresses: they would count as a second .json file
const MAC_JUNK = /^__MACOSX\/|(?:^|\/)\._/;

// a stored (uncompressed) entry is read with its real size, whatever size the ZIP declares: check both
const fits = (f, max) => Math.max(f.size, f.originalSize) <= max;

/**
 * Random image name like the existing ones ("PTWxNN2RRl9vC8G")
 * @param {function(Uint8Array): Uint8Array} [random] - fills the array with random bytes
 * @returns {string}
 */
export function newImageId(random = (bytes) => crypto.getRandomValues(bytes)) {
    // 256 % 62 favours the first 8 characters by a hair: irrelevant for a file name
    return Array.from(random(new Uint8Array(15)), b => ID_CHARS[b % ID_CHARS.length]).join("");
}

/**
 * A guess with exactly the fields the API knows, in the order of the README example
 */
function toEntry(g) {
    const entry = { map: g.map, mode: g.mode, url: g.url, lat: g.lat, lng: g.lng };
    if (g.submitter) entry.submitter = g.submitter;
    return entry;
}

/**
 * ZIP with guesses.json and every image at its url path
 * @param {Array<{entry: Object, image: Uint8Array}>} items
 * @returns {Uint8Array}
 */
export function packGuesses(items) {
    const files = { "guesses.json": strToU8(JSON.stringify(items.map(i => toEntry(i.entry)), null, 4)) };
    items.forEach(i => {
        const path = i.entry.url.slice(1);
        // a second image on the same path would silently replace the first one
        if (Object.hasOwn(files, path)) throw new Error(`duplicate image path ${path}`);
        // webp is already compressed: storing it costs nothing in size
        files[path] = [i.image, { level: 0 }];
    });
    return zipSync(files);
}

/**
 * True when the bytes are a WebP file (RIFF container with the WEBP tag)
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isWebp(bytes) {
    const ascii = (from, to) => String.fromCharCode(...bytes.subarray(from, to));
    return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
}

/**
 * Reads a submitted ZIP. It comes from a stranger: only known files are inflated, every entry is checked and rebuilt
 * @param {Uint8Array} bytes
 * @returns {Array<{entry: Object|null, image: Uint8Array|null, error: string|null}>}
 * @throws {Error} when the file as a whole is unusable
 */
export function unpackGuesses(bytes) {
    // the filter sees every entry of the ZIP: note them all, but inflate only the .json file in this first pass
    const entries = [];
    const unzip = (keep) => {
        try {
            return unzipSync(bytes, { filter: f => { entries.push(f); return keep(f); } });
        } catch {
            throw new Error("not a ZIP file");
        }
    };
    const jsonFiles = unzip(f => !MAC_JUNK.test(f.name) && JSON_PATH.test(f.name) && fits(f, MAX_JSON));
    const jsonPaths = Object.keys(jsonFiles);
    if (!jsonPaths.length) throw new Error("no .json file (up to 1 MB)");
    if (jsonPaths.length > 1) throw new Error(`more than one .json file: ${jsonPaths.join(", ")}`);
    const [jsonPath] = jsonPaths;
    // images are looked up next to the .json file
    const dir = jsonPath.slice(0, jsonPath.lastIndexOf("/") + 1);
    let list;
    try {
        list = JSON.parse(strFromU8(jsonFiles[jsonPath]));
    } catch {
        throw new Error(`${jsonPath} is not valid JSON`);
    }
    if (!Array.isArray(list)) throw new Error(`${jsonPath} is not a list`);

    // second pass: only the images a guess refers to, so nothing else in a stranger's ZIP is ever inflated
    const wanted = new Set(list.filter(g => typeof g?.url === "string").map(g => dir + g.url.slice(1)));
    const images = entries.filter(f => wanted.has(f.name) && !MAC_JUNK.test(f.name) && IMAGE_PATH.test(f.name) && fits(f, MAX_IMAGE));
    const total = images.reduce((sum, f) => sum + Math.max(f.size, f.originalSize), 0);
    if (total > MAX_TOTAL) throw new Error(`too large: more than ${MAX_TOTAL / 1024 / 1024} MB of images`);
    const keep = new Set(images.map(f => f.name));
    const files = unzip(f => keep.has(f.name));

    return list.map(g => {
        const path = typeof g?.url === "string" ? dir + g.url.slice(1) : "";
        // own keys only: a url like "/__proto__" must not find Object.prototype
        const image = Object.hasOwn(files, path) ? files[path] : null;
        let error = null;
        if (!validGuess(g)) error = "invalid data";
        else if (!MODES.includes(g.mode)) error = "invalid mode";
        else if (!image) error = "image missing";
        if (error) return { entry: null, image, error };
        // the game ignores case, but the map list's spelling is what the submit tool writes and the reveal shows
        const map = findMap(g.map).name;
        return { entry: toEntry({ ...g, map }), image, error };
    });
}

/**
 * "squadguessr-<name>-<YYYY-MM-DD>.zip" with the name cut down to safe file name characters
 * @param {string} name
 * @param {Date} [date]
 * @returns {string}
 */
export function zipFileName(name, date = new Date()) {
    const safe = String(name ?? "").replace(/[^A-Za-z0-9_-]/g, "") || "anonymous";
    const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, "0")).join("-");
    return `squadguessr-${safe}-${day}.zip`;
}

/**
 * Hands the bytes to the browser as a file download
 * @param {Uint8Array} bytes
 * @param {string} fileName
 */
export function downloadZip(bytes, fileName) {
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    // the download has started once click() returns; revoking a bit later keeps slow browsers safe
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}
