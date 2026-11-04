import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsForDistance, levenshtein, mapNameMatches, distance, mapSize, scoreAnswer, rankMoves, speedBonus } from "../src/js/scoring.js";
import { MAPS, initMapsProperties } from "../src/js/data/maps.js";

test("pointsForDistance on a 3000m map", () => {
    assert.deepEqual(pointsForDistance(0, 3000), { points: 100, icon: "! 💯" });
    assert.equal(pointsForDistance(20, 3000).points, 100);
    assert.deepEqual(pointsForDistance(35, 3000), { points: 90, icon: "! 🌟" });
    assert.equal(pointsForDistance(500, 3000).points, 10);
    assert.deepEqual(pointsForDistance(501, 3000), { points: 0, icon: "... ❌" });
});

test("pointsForDistance scales thresholds with map size", () => {
    assert.equal(pointsForDistance(40, 6000).points, 100);
    assert.equal(pointsForDistance(70, 6000).points, 90);
});

test("levenshtein is the plain edit distance", () => {
    assert.equal(levenshtein("narva", "narva"), 0);
    assert.equal(levenshtein("narv", "narva"), 1);
    assert.equal(levenshtein("kohat", "narva"), 5);
});

test("mapNameMatches tolerates case, spaces and small typos", () => {
    assert.equal(mapNameMatches("Al Basrah", "AlBasrah"), true);
    assert.equal(mapNameMatches("goose bay", "GooseBay"), true);
    assert.equal(mapNameMatches("narv", "Narva"), true);
    assert.equal(mapNameMatches("narva", "Narva_f"), true);
    assert.equal(mapNameMatches("kohat", "Narva"), false);
});

test("mapNameMatches accepts the full official map names", () => {
    const official = [["Kohat Toi", "Kohat"], ["Kamdesh Highlands", "Kamdesh"], ["Sumari Bala", "Sumari"], ["Tallil Outskirts", "Tallil"],
        ["Fallujah City", "Fallujah"], ["Narva (Flooded)", "Narva_f"], ["Fool's Road", "FoolsRoad"], ["Jensen's Range", "Jensen"],
        ["Pacific Proving Grounds", "Pacific"], ["Kohta Toi", "Kohat"]];
    official.forEach(([answer, map]) => assert.equal(mapNameMatches(answer, map), true, answer));
});

test("mapNameMatches does not hand the points to a map a few typos away from the one typed", () => {
    assert.equal(mapNameMatches("Kokan", "Kohat"), false);
    assert.equal(mapNameMatches("Kohat", "Kokan"), false);
    assert.equal(mapNameMatches("Kohat Toi", "Kokan"), false);
    assert.equal(mapNameMatches("Kokan", "Kokan"), true);
});

test("mapNameMatches cannot be gamed by listing several maps", () => {
    assert.equal(mapNameMatches("kohat gorodok anvil belaya chora narva", "Narva"), false);
    assert.equal(mapNameMatches("narva kohat", "Kohat"), false);
});

test("distance is euclidean on lat/lng", () => {
    assert.equal(distance({ lat: 0, lng: 0 }, { lat: 3, lng: 4 }), 5);
});

test("mapSize matches initMapsProperties, case-insensitive", () => {
    initMapsProperties();
    const narva = MAPS.find(m => m.name === "Narva");
    assert.equal(mapSize("narva"), narva.size);
    assert.ok(narva.size > 0);
    assert.equal(mapSize("doesNotExist"), undefined);
});

test("scoreAnswer classic and mapFinder", () => {
    const guess = { map: "Narva", lat: 100, lng: 200 };
    assert.deepEqual(scoreAnswer("classic", guess, { lat: 100, lng: 200 }), { distance: 0, points: 100 });
    assert.equal(scoreAnswer("classic", guess, { lat: 100000, lng: 200 }).points, 0);
    assert.deepEqual(scoreAnswer("mapFinder", guess, { mapName: "narv" }), { distance: null, points: 100 });
    assert.equal(scoreAnswer("mapFinder", guess, { mapName: "gorodok" }).points, 0);
    assert.equal(scoreAnswer("mapFinder", guess, { mapName: "kohat gorodok anvil belaya chora narva" }).points, 0);
});

test("rankMoves compares the places before and after a round", () => {
    // before: B 150, A 100, C 90
    const results = [
        { id: "A", score: 180, points: 80 },
        { id: "B", score: 160, points: 10 },
        { id: "C", score: 90, points: 0 },
    ];
    assert.deepEqual(rankMoves(results), { A: "up", B: "down" });
});

test("rankMoves gives equal scores the same place", () => {
    // A and B shared the lead and still do: nobody moved, whatever order the sort left them in
    assert.deepEqual(rankMoves([
        { id: "B", score: 150, points: 50 },
        { id: "A", score: 150, points: 50 },
        { id: "C", score: 90, points: 0 },
    ]), {});
    // A pulls ahead: A was first already, only B drops
    assert.deepEqual(rankMoves([
        { id: "A", score: 180, points: 80 },
        { id: "B", score: 150, points: 50 },
    ]), { B: "down" });
});

test("speedBonus: a quarter of the points once more, scaled by the share of time left", () => {
    assert.equal(speedBonus(100, 1), 25);
    assert.equal(speedBonus(100, 0.5), 13);
    assert.equal(speedBonus(85, 0.5), 11);
    assert.equal(speedBonus(60, 1), 15);
    assert.equal(speedBonus(30, 1), 8);
    assert.equal(speedBonus(0, 1), 0);
    assert.equal(speedBonus(100, 0), 0);
});

test("speedBonus: the time left counts as 0–1, so an answer in the grace second gets nothing", () => {
    assert.equal(speedBonus(100, -0.02), 0);
    assert.equal(speedBonus(100, 1.01), 25);
});

test("rankMoves counts the speed bonus as part of the round", () => {
    // before: B 150, A 140; A passes B only thanks to the bonus
    assert.deepEqual(rankMoves([
        { id: "A", score: 245, points: 90, bonus: 15 },
        { id: "B", score: 240, points: 90, bonus: 0 },
    ]), { A: "up", B: "down" });
});
