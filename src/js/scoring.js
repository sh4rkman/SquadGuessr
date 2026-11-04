import { MAPS, initMapsProperties, findMap } from "./data/maps.js";

// base thresholds for a 3000x3000 map
const BASE_STEPS = [
    { maxDistance: 20, points: 100, icon: "! 💯" },
    { maxDistance: 50, points: 80, icon: "! 🌟" },
    { maxDistance: 100, points: 60, icon: "👏🏼" },
    { maxDistance: 200, points: 40, icon: "👍🏼" },
    { maxDistance: 300, points: 20, icon: "😐" },
    { maxDistance: 500, points: 10, icon: ".. 🤨" },
];

/**
 * Points (and display icon) for a guess `distance` meters away on a map `size` meters wide
 */
export function pointsForDistance(distance, size) {
    const scale = size / 3000; // 1 for base map, >1 for bigger maps, <1 for smaller
    const steps = BASE_STEPS.map(s => ({ ...s, maxDistance: s.maxDistance * scale }));

    if (distance <= steps[0].maxDistance) return { points: steps[0].points, icon: steps[0].icon };

    for (let i = 1; i < steps.length; i++) {
        if (distance <= steps[i].maxDistance) {
            const prev = steps[i - 1];
            const curr = steps[i];
            const ratio = (distance - prev.maxDistance) / (curr.maxDistance - prev.maxDistance);
            return { points: Math.round(prev.points + (curr.points - prev.points) * ratio), icon: curr.icon };
        }
    }

    return { points: 0, icon: "... ❌" };
}

/**
 * Plain edit distance between two strings
 */
export function levenshtein(a, b) {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        let diagonal = row[0];
        row[0] = i;
        for (let j = 1; j <= b.length; j++) {
            const above = row[j];
            row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
            diagonal = above;
        }
    }
    return row[b.length];
}

const compact = (str) => str.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Fewest typos between the start of a (compact) answer and a (compact) map name
 */
function typos(typed, name) {
    return Math.min(...Array.from({ length: typed.length + 1 }, (_, i) => levenshtein(typed.slice(0, i), name)));
}

/**
 * Does a typed answer name this map? Case, spaces, "_" and up to 2 typos are forgiven.
 * Official names go on after the map id ("Kohat Toi", "Narva Flooded"), so the answer may too; but only its start counts,
 * so listing several maps in one answer matches the first of them at most.
 * An answer that fits another map better names that one ("Kokan" is 2 typos from Kohat); layers of one map
 * ("Narva" / "Narva_f") count as the same map.
 */
export function mapNameMatches(answer, mapName) {
    const typed = compact(answer);
    const name = compact(mapName);
    const own = typos(typed, name);
    return own <= 2 && MAPS.map(m => compact(m.name))
        .filter(other => !other.startsWith(name) && !name.startsWith(other))
        .every(other => typos(typed, other) >= own);
}

export function distance(a, b) {
    return Math.hypot(a.lat - b.lat, a.lng - b.lng);
}

export function mapSize(mapName) {
    const map = findMap(mapName);
    if (map && map.size === undefined) initMapsProperties();
    return map?.size;
}

/**
 * Score one answer against a guess, in game coordinates
 */
export function scoreAnswer(mode, guess, answer) {
    if (mode === "mapFinder") {
        return { distance: null, points: mapNameMatches(answer.mapName, guess.map) ? 100 : 0 };
    }
    const d = distance(guess, answer);
    return { distance: d, points: pointsForDistance(d, mapSize(guess.map)).points };
}

// the speed bonus is at most this share of the points: the less accurate the answer, the less a quick one earns
const BONUS_SHARE = 0.25;

/**
 * Extra points for a quick answer: BONUS_SHARE of the points once more, scaled by the share of time `left` (0–1).
 * At most 25 on top of a perfect 100
 */
export function speedBonus(points, left) {
    return Math.round(points * BONUS_SHARE * Math.min(1, Math.max(0, left)));
}

/**
 * The bonus as shown after a round's points ("96 ⚡+21"), nothing when there is none
 */
export function bonusText(bonus) {
    return bonus ? ` ⚡+${bonus}` : "";
}

/**
 * Who moved up or down with this round's points: { id: "up" | "down" }, unmoved players left out.
 * A place is 1 + the number of players ahead, so equal scores share it and the sort order of a tie moves nobody
 */
export function rankMoves(results) {
    const place = (score, scores) => scores.filter(s => s > score).length;
    const after = results.map(r => r.score);
    const before = results.map(r => r.score - r.points - (r.bonus ?? 0));
    const moves = {};
    results.forEach((r, i) => {
        const change = place(before[i], before) - place(after[i], after);
        if (change) moves[r.id] = change > 0 ? "up" : "down";
    });
    return moves;
}
