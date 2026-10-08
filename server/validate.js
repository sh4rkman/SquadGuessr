import { findMap } from "../src/js/data/maps.js";

const MODES = ["classic", "mapFinder"];
const TIMERS = [0, 15, 60];
const ROUNDS = [3, 5, 10];
// any plain file name under /img/ (real ones look like "Screenshot (301).webp"): a rejected name fails START for the
// whole game. Kept out is only what could leave the double-quoted HTML attribute the url ends up in or the path
// itself: quotes, angle brackets, backslash, control characters and whitespace other than a space, and ?, # and %
// (browsers turn %2e%2e into ..); ".." is checked separately
const URL_PATTERN = /^\/img\/[^"<>\\?#%\p{Cc}\p{Zl}\p{Zp}]+$/u;

/**
 * Player name as shown to others, or null if nothing usable is left
 */
export function cleanName(name) {
    if (typeof name !== "string") return null;
    // NFKC folds look-alike forms; \p{C} drops control, format (zero-width, bidi) and unassigned characters
    const printable = name.normalize("NFKC").replace(/\p{C}/gu, "").replace(/\s+/g, " ");
    // Array.from counts code points, so an emoji is never cut in half
    const clean = Array.from(printable.trim()).slice(0, 20).join("").trim();
    return clean || null;
}

export function validSettings(s) {
    return Boolean(s) && MODES.includes(s.mode) && TIMERS.includes(s.timer) && ROUNDS.includes(s.rounds);
}

export function validGuesses(guesses, rounds) {
    return Array.isArray(guesses) && guesses.length === rounds && guesses.every(validGuess);
}

export function validGuess(g) {
    return Boolean(g)
        && typeof g.map === "string" && Boolean(findMap(g.map))
        && typeof g.url === "string" && g.url.length <= 200 && URL_PATTERN.test(g.url) && !g.url.includes("..")
        && Number.isFinite(g.lat) && Number.isFinite(g.lng)
        && (g.submitter === undefined || g.submitter === null || (typeof g.submitter === "string" && g.submitter.length <= 40));
}

export function validAnswer(msg, mode) {
    if (mode === "mapFinder") return typeof msg.mapName === "string" && msg.mapName.length <= 40;
    return Number.isFinite(msg.lat) && Number.isFinite(msg.lng);
}
