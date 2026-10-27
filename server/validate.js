import { findMap } from "../src/js/data/maps.js";

const MODES = ["classic", "mapFinder"];
// rush and the automatic next round: 5–30 s in 5 s steps
const SECONDS = [5, 10, 15, 20, 25, 30];
// chill, rush, timed
const TIMERS = [0, ...SECONDS, 60];
// 0: the host moves on with NEXT
const NEXTS = [0, ...SECONDS];
const ROUNDS = [3, 5, 10];
// team play: "off" is everyone for themselves
const TEAM_MODES = ["off", "sum", "centroid", "leader"];
const MAX_TEAMS = 10;
// Leader: how long the leaders have to pick their team's guess
const DECIDES = [10, 15, 20, 30, 45, 60];
// any plain file name under /img/ (real ones look like "Screenshot (301).webp"): a rejected name fails START for the
// whole game. Kept out is only what could leave the double-quoted HTML attribute the url ends up in or the path
// itself: quotes, angle brackets, backslash, control characters and whitespace other than a space, and ?, # and %
// (browsers turn %2e%2e into ..); ".." is checked separately
const URL_PATTERN = /^\/img\/[^"<>\\?#%\p{Cc}\p{Zl}\p{Zp}]+$/u;

// line breaks, tabs and their kin become spaces before the control characters go: else the words around them glue
const BREAKS = /[\t\n\v\f\r\u0085]/g;
// \p{C} (control, format, unassigned) except the joiners ZWNJ and ZWJ: emoji sequences and scripts like Persian need them
const INVISIBLE = /(?![\u200C\u200D])\p{C}/gu;
// letters that draw nothing: the Hangul fillers (NFKC turns U+3164 and U+FFA0 into U+1160) and the blank braille pattern
const BLANK = /[\u115F\u1160\u2800]/gu;
// Zalgo text: past a few combining marks on one letter they only pile up over the lines around it
const MARK_PILE = /(\p{M}{4})\p{M}+/gu;
// something to see: marks, joiners and variation selectors on their own draw nothing
const VISIBLE = /[\p{L}\p{N}\p{P}\p{S}]/u;
const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
// names keep letters of every script with their accents and vowel signs, digits, spaces and - _ . ' only. Whatever
// Unicode calls ignorable goes as well, even as a mark or a "letter" (CGJ, variation selectors, Hangul fillers, joiners):
// an invisible one would make "Hans" plus it a second, identical looking Hans
const NAME_DROP = /[^\p{L}\p{M}\p{N} \-_.']|\p{Default_Ignorable_Code_Point}/gu;
const NAME_NEEDS = /[\p{L}\p{N}]/u;

/**
 * Player name as shown to others, or null if no letter or digit is left
 */
export function cleanName(name) {
    if (typeof name !== "string") return null;
    // like cleanText, nothing past 4 × 20 raw characters could ever show; NFKC first, so a fullwidth or styled letter
    // (and a no-break space) counts as the plain one it stands for
    const allowed = name.slice(0, 80).normalize("NFKC").replace(BREAKS, " ").replace(NAME_DROP, "");
    const clean = cleanText(allowed, 20);
    return clean && NAME_NEEDS.test(clean) ? clean : null;
}

/**
 * Text as shown to others, one line of at most `max` characters as seen, or null if nothing visible is left
 */
export function cleanText(text, max) {
    if (typeof text !== "string") return null;
    // a frame may carry 64 KB, and NFKC over all of it takes up to ~20 ms: nothing past this could ever show anyway
    const head = text.slice(0, max * 4);
    // NFKC folds look-alike forms; INVISIBLE drops bidi controls and zero-width characters among others
    const printable = head.normalize("NFKC").replace(BREAKS, " ").replace(INVISIBLE, "").replace(BLANK, "").replace(MARK_PILE, "$1").replace(/\s+/g, " ");
    // counted as seen, so a flag, a skin tone or a family emoji is one character and never cut in half
    const seen = Array.from(GRAPHEMES.segment(printable.trim()), s => s.segment);
    // the raw cut above may have split the last one. Only a text longer than any client sends gets here, so it
    // simply loses its last character, even when the cut happened to fall between two
    if (text.length > head.length) seen.pop();
    const clean = seen.slice(0, max).join("").trim();
    return VISIBLE.test(clean) ? clean : null;
}

export function validSettings(s) {
    // an older cached client sends no next, no keepCode and nothing about teams
    return Boolean(s) && MODES.includes(s.mode) && TIMERS.includes(s.timer) && ROUNDS.includes(s.rounds)
        && (s.next === undefined || NEXTS.includes(s.next))
        && (s.keepCode === undefined || typeof s.keepCode === "boolean")
        && validTeamSettings(s);
}

/**
 * Team play is classic only: what a team plays is a point on the map. A missing field takes its default, null does not
 */
function validTeamSettings({ mode, team = "off", teams = 2, penalty = false, decide = 20 }) {
    return TEAM_MODES.includes(team) && (team === "off" || mode === "classic")
        && Number.isInteger(teams) && teams >= 2 && teams <= MAX_TEAMS
        && typeof penalty === "boolean"
        && DECIDES.includes(decide);
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
