import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanName, cleanText, validSettings, validGuesses, validAnswer } from "./validate.js";

const guess = (over = {}) => ({ map: "Narva", url: "/img/guesses/narva_1.webp", lat: 1.5, lng: -2, ...over });

test("cleanName trims, strips control chars and caps length", () => {
    assert.equal(cleanName("  Max "), "Max");
    assert.equal(cleanName(" max\u0007"), "max");
    assert.equal(cleanName("x".repeat(30)), "x".repeat(20));
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

test("cleanName counts characters as seen when truncating: a vowel sign stays with its letter", () => {
    assert.equal(cleanName("ABCDEFGHIJKLMNOPQRSễ"), "ABCDEFGHIJKLMNOPQRSễ");
    assert.equal(cleanName("x".repeat(18) + "राहुल"), "x".repeat(18) + "राहु");
});

test("names keep letters of every script, digits, spaces and - _ . ' only", () => {
    for (const name of ["Jörg", "Łukasz", "Nguyễn", "राहुल", "李明", "Ana-Lena", "O'Brien", "Max_99", "J.R. Smith"]) {
        assert.equal(cleanName(name), name);
    }
    assert.equal(cleanName("🐺Wolf"), "Wolf");
    assert.equal(cleanName("<b>Hi</b>"), "bHib");
    assert.equal(cleanName("Max!?"), "Max");
});

test("names drop whatever draws nothing, so a look-alike is the same name", () => {
    assert.equal(cleanName("Hans\u034f"), "Hans");
    assert.equal(cleanName("Ha\ufe0fns"), "Hans");
    assert.equal(cleanName("\u3164Hans\u17b4"), "Hans");
    assert.equal(cleanName("Hans\u{E0041}"), "Hans");
});

test("a name needs a letter or a digit", () => {
    for (const name of ["🐺🐺", "---", "_ . '", "\u034f", "♥"]) assert.equal(cleanName(name), null, name);
});

test("cleanText turns line breaks and tabs into spaces instead of gluing the words", () => {
    assert.equal(cleanText("line1\nline2\r\nline3\tTab", 200), "line1 line2 line3 Tab");
    assert.equal(cleanName("Max\tMüller"), "Max Müller");
});

test("cleanText cleans like a name but cuts at its own length", () => {
    assert.equal(cleanText("  hello\u200b  world ", 200), "hello world");
    assert.equal(cleanText("x".repeat(300), 200), "x".repeat(200));
    assert.equal(cleanText("   ", 200), null);
    assert.equal(cleanText(null, 200), null);
});

test("cleanText drops letters that draw nothing: no invisible names or lines", () => {
    assert.equal(cleanName("\u3164"), null);
    assert.equal(cleanName("\u2800 \uffa0 \u115f\u1160"), null);
    assert.equal(cleanText("Bob\u3164", 200), "Bob");
});

test("cleanText keeps accents but cuts piles of combining marks (Zalgo text) down to four", () => {
    assert.equal(cleanText("H" + "\u0336".repeat(60) + "i", 200), "H" + "\u0336".repeat(4) + "i");
    assert.equal(cleanText("Ça va? Tiếng Việt", 200), "Ça va? Tiếng Việt");
});

test("cleanText looks at no more of a huge text than could ever show: 4 × max raw characters", () => {
    assert.equal(cleanText(" ".repeat(800) + "x", 200), null);
    assert.equal(cleanText(" ".repeat(799) + "x", 200), "x");
});

test("cleanText keeps the joiners that emoji and many scripts need; names drop them (no second, identical looking Hans)", () => {
    assert.equal(cleanText("👨‍👩‍👧 🏳️‍🌈", 200), "👨‍👩‍👧 🏳️‍🌈");
    assert.equal(cleanText("می‌خواهم", 200), "می‌خواهم");
    assert.equal(cleanName("Ha\u200dns"), "Hans");
    assert.equal(cleanName("Ha\u200cns"), "Hans");
});

test("cleanText wants something to see: marks, joiners and selectors alone are nothing", () => {
    assert.equal(cleanName("\ufe0f\ufe0f\ufe0f\ufe0f"), null);
    assert.equal(cleanName("\u034f"), null);
    assert.equal(cleanName("\u17b4\u17b5"), null);
    assert.equal(cleanText("\u200d\u200c", 200), null);
    assert.equal(cleanText("\u2764\ufe0f", 200), "\u2764\ufe0f");
});

test("cleanText counts characters as seen: a flag, a skin tone or a family is one and never cut in half", () => {
    assert.equal(cleanText("x".repeat(199) + "🇩🇪", 200), "x".repeat(199) + "🇩🇪");
    assert.equal(cleanText("x".repeat(200) + "🇩🇪", 200), "x".repeat(200));
    assert.equal(cleanText("👍🏽👍🏽👍🏽xxxxxxxxxx", 4), "👍🏽👍🏽👍🏽x");
    // the raw limit (4 × max) cuts into the 100th family: that one is dropped, not shown in pieces
    const family = "👨‍👩‍👧";
    assert.equal(cleanText("x" + family.repeat(150), 200), "x" + family.repeat(99));
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

test("validSettings: team play takes Sum with 2–10 teams and minus points on or off, in classic only", () => {
    const settings = (over) => validSettings({ mode: "classic", timer: 0, rounds: 5, ...over });
    assert.equal(settings({ team: "off" }), true);
    assert.equal(settings({ team: "sum", teams: 2, penalty: false }), true);
    assert.equal(settings({ team: "sum", teams: 10, penalty: true }), true);
    [1, 11, 2.5, "2", null].forEach(teams => assert.equal(settings({ team: "sum", teams, penalty: false }), false, `teams ${teams}`));
    ["yes", 1, null].forEach(penalty => assert.equal(settings({ team: "sum", teams: 2, penalty }), false, `penalty ${penalty}`));
    assert.equal(settings({ team: "solo" }), false);
    // Sum was called Average once: no client sends that any more
    assert.equal(settings({ team: "average" }), false);
    // a team guesses points on the map: never in Find the Map
    assert.equal(validSettings({ mode: "mapFinder", timer: 0, rounds: 5, team: "sum", teams: 2, penalty: false }), false);
    assert.equal(validSettings({ mode: "mapFinder", timer: 0, rounds: 5, team: "off" }), true);
    // an older cached client knows nothing of teams
    assert.equal(settings({}), true);
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

test("validSettings: team play also takes Midpoint", () => {
    assert.equal(validSettings({ mode: "classic", timer: 0, rounds: 5, team: "centroid", teams: 3, penalty: false }), true);
    assert.equal(validSettings({ mode: "mapFinder", timer: 0, rounds: 5, team: "centroid", teams: 3, penalty: false }), false);
});

test("validSettings: team play also takes Leader, whose leaders get 10–60 s to decide", () => {
    const settings = (over) => validSettings({ mode: "classic", timer: 0, rounds: 5, team: "leader", teams: 2, penalty: false, ...over });
    [10, 15, 20, 30, 45, 60].forEach(decide => assert.equal(settings({ decide }), true, `decide ${decide}`));
    [0, 5, 25, 90, "20", null].forEach(decide => assert.equal(settings({ decide }), false, `decide ${decide}`));
    assert.equal(settings({}), true);
});
