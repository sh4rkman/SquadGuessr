import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, validSettings, validGuesses, validAnswer } from "./validate.js";

const guess = (over = {}) => ({ map: "Narva", url: "/img/guesses/narva_1.webp", lat: 1.5, lng: -2, ...over });

test("cleanName trims, strips control chars and caps length", () => {
    assert.equal(cleanName("  Max "), "Max");
    assert.equal(cleanName(" max\u0007"), "max");
    assert.equal(cleanName("x".repeat(30)), "x".repeat(20));
    assert.equal(cleanName("<b>Hi</b>"), "<b>Hi</b>");
    assert.equal(cleanName("   "), null);
    assert.equal(cleanName(42), null);
    assert.equal(cleanName(undefined), null);
});

test("cleanName removes invisible characters and collapses inner whitespace", () => {
    assert.equal(cleanName("Bob\u0085"), "Bob");
    assert.equal(cleanName("Bob\u200b"), "Bob");
    assert.equal(cleanName("B\u202eob"), "Bob");
    assert.equal(cleanName("Bo  b"), "Bo b");
    assert.equal(cleanName("\uff22ob"), "Bob");
    assert.equal(cleanName("\u200b\u200b"), null);
});

test("cleanName never splits an emoji when truncating", () => {
    assert.equal(cleanName("ABCDEFGHIJKLMNOPQRS😀"), "ABCDEFGHIJKLMNOPQRS😀");
    assert.equal(cleanName("ABCDEFGHIJKLMNOPQRST😀"), "ABCDEFGHIJKLMNOPQRST");
});

test("validSettings accepts only allowed values", () => {
    assert.equal(validSettings({ mode: "classic", timer: 0, rounds: 5 }), true);
    assert.equal(validSettings({ mode: "mapFinder", timer: 15, rounds: 10 }), true);
    assert.equal(validSettings({ mode: "classic", timer: "0", rounds: 5 }), false);
    assert.equal(validSettings({ mode: "hard", timer: 0, rounds: 5 }), false);
    assert.equal(validSettings({ mode: "classic", timer: 0, rounds: 7 }), false);
    assert.equal(validSettings(null), false);
});

test("validSettings: rush takes 5–30 s in 5 s steps; the next round comes from the host (0) or after 5–30 s", () => {
    const settings = (over) => validSettings({ mode: "classic", timer: 0, rounds: 5, ...over });
    [0, 5, 10, 25, 30, 60].forEach(timer => assert.equal(settings({ timer }), true, `timer ${timer}`));
    [3, 17, 35, 45, 61].forEach(timer => assert.equal(settings({ timer }), false, `timer ${timer}`));
    [0, 5, 15, 30].forEach(next => assert.equal(settings({ next }), true, `next ${next}`));
    [3, 17, 35, 60, "15", null].forEach(next => assert.equal(settings({ next }), false, `next ${next}`));
    // an older cached client knows nothing of next
    assert.equal(settings({ next: undefined }), true);
});

test("validSettings: keepCode is a boolean, and an older cached client sends none", () => {
    const settings = (over) => validSettings({ mode: "classic", timer: 0, rounds: 5, ...over });
    [true, false, undefined].forEach(keepCode => assert.equal(settings({ keepCode }), true, `keepCode ${keepCode}`));
    ["true", 1, null].forEach(keepCode => assert.equal(settings({ keepCode }), false, `keepCode ${keepCode}`));
});

test("validGuesses checks count and every field", () => {
    assert.equal(validGuesses([guess(), guess(), guess()], 3), true);
    assert.equal(validGuesses([guess({ submitter: "Dan" }), guess({ map: "narva" }), guess({ submitter: null })], 3), true);
    // real hint images are named like this (Sanxian): a rejected name made START fail for the whole game
    assert.equal(validGuesses([guess(), guess(), guess({ url: "/img/guesses/Screenshot (301).webp" })], 3), true);
    assert.equal(validGuesses([guess(), guess()], 3), false);
    assert.equal(validGuesses("nope", 3), false);
    assert.equal(validGuesses([guess(), guess(), guess({ map: "Atlantis" })], 3), false);
    assert.equal(validGuesses([guess(), guess(), guess({ url: "https://evil/x.webp" })], 3), false);
    assert.equal(validGuesses([guess(), guess(), guess({ url: "/img/../secret" })], 3), false);
    assert.equal(validGuesses([guess(), guess(), guess({ url: "/img/\"onerror=x" })], 3), false);
    assert.equal(validGuesses([guess(), guess(), guess({ lat: "1" })], 3), false);
    assert.equal(validGuesses([guess(), guess(), guess({ lng: Infinity })], 3), false);
    assert.equal(validGuesses([guess(), guess(), guess({ submitter: "x".repeat(41) })], 3), false);
    assert.equal(validGuesses([guess(), guess(), null], 3), false);
});

test("guess urls: ordinary file names pass, anything that could leave the attribute or the path does not", () => {
    const ok = url => validGuesses([guess({ url })], 1);
    // a rejected name fails START for the whole game, so any plain file name must pass
    for (const url of ["/img/guesses/Kaszuby's (2).webp", "/img/guesses/shot[1]+final,a.webp", "/img/guesses/Łódź_2024.webp"]) {
        assert.equal(ok(url), true, url);
    }
    for (const url of ["/img/a\tb.webp", "/img/a\nb.webp", "/img/a<b.webp", "/img/a>b.webp", "/img/a\\b.webp",
        "/img/a.webp?x=1", "/img/a.webp#x", "/img/%2e%2e/secret", "/img/a\"b.webp", "/img/../secret", "/api/x.webp"]) {
        assert.equal(ok(url), false, url);
    }
});

test("validAnswer per mode", () => {
    assert.equal(validAnswer({ lat: 1, lng: 2 }, "classic"), true);
    assert.equal(validAnswer({ lat: NaN, lng: 2 }, "classic"), false);
    assert.equal(validAnswer({ mapName: "narva" }, "classic"), false);
    assert.equal(validAnswer({ mapName: "narva" }, "mapFinder"), true);
    assert.equal(validAnswer({ mapName: "x".repeat(41) }, "mapFinder"), false);
    assert.equal(validAnswer({ lat: 1, lng: 2 }, "mapFinder"), false);
});
