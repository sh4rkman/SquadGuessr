import { test } from "node:test";
import assert from "node:assert/strict";
import { pointsForDistance, levenshtein, mapNameMatches, distance, mapSize, scoreAnswer, rankMoves, penaltyPoints, MAX_PENALTY, centroid } from "../src/js/scoring.js";
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

test("penaltyPoints: 0 up to the last scoring step, then down to −50 at three times its distance", () => {
    // on a 3000m map the last step is 500m
    assert.equal(penaltyPoints(0, 3000), 0);
    // 0, not -0: assert.equal compares with Object.is
    assert.equal(penaltyPoints(500, 3000), 0);
    assert.equal(penaltyPoints(1000, 3000), -25);
    assert.equal(penaltyPoints(1500, 3000), -50);
    assert.equal(penaltyPoints(5000, 3000), -50);
    // the step scales with the map like the points do
    assert.equal(penaltyPoints(2000, 6000), -25);
    assert.equal(MAX_PENALTY, 50);
});

test("centroid is the plain average position", () => {
    assert.deepEqual(centroid([{ lat: -100, lng: 50 }]), { lat: -100, lng: 50 });
    assert.deepEqual(centroid([{ lat: 0, lng: 0 }, { lat: -100, lng: 300 }, { lat: -200, lng: 0 }]), { lat: -100, lng: 100 });
});
