import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, MAX_PLAYERS, RECONNECT_MS, LOAD_FIRST_MS, LOAD_MS, COUNTDOWN_READY_MS, COUNTDOWN_FORCED_MS, KICK_WAIT_MS, HANDOVER_MS, MAX_PAST } from "./session.js";
import { CHAT_MAX, CHAT_GAP_MS, CHAT_HISTORY } from "../src/js/chatLimits.js";
import { mapSize } from "../src/js/scoring.js";

const CLASSIC = { mode: "classic", timer: 0, rounds: 3, next: 0, keepCode: false, speedBonus: false };
const GUESSES = [
    { map: "Narva", url: "/img/guesses/a.webp", lat: -100, lng: 200, submitter: "Dan" },
    { map: "GooseBay", url: "/img/guesses/b.webp", lat: -300, lng: 400 },
    { map: "Kohat", url: "/img/guesses/c.webp", lat: -500, lng: 600 },
];

function setup(settings = CLASSIC) {
    let t = 1000;
    const sent = [];
    let codes = 0;
    const s = new Session("ABCD", { send: (conn, msg) => sent.push({ conn, msg }), now: () => t, newCode: () => `NEW${++codes}` });
    const all = (conn, type) => sent.filter(x => x.conn === conn && x.msg.type === type).map(x => x.msg);
    const last = (conn, type) => all(conn, type).at(-1);
    // what the players wrote, without the notices of who came and went
    const said = (conn) => all(conn, "chat").filter(m => !m.system).map(m => m.text);
    const host = { id: "host" };
    s.create(host, { name: "Hans", settings });
    const advance = (ms) => { t += ms; };
    // a started game reaches round 1: every device has its images and the countdown (at most the long one) ran out
    const begin = (conn = host) => {
        s.handle(conn, { type: "start", guesses: GUESSES });
        readyAll(s, 0);
        advance(COUNTDOWN_FORCED_MS);
        s.tick();
    };
    return { s, sent, host, all, last, said, advance, begin };
}

function withGuest(settings) {
    const ctx = setup(settings);
    ctx.guest = { id: "guest" };
    ctx.s.join(ctx.guest, { name: "Max" });
    return ctx;
}

// every connected player reports that round i's images are loaded
function readyAll(s, i) {
    s.players.forEach(p => { if (p.connected) s.handle(p.conn, { type: "ready", index: i }); });
}

function started(settings) {
    const ctx = withGuest(settings);
    ctx.begin();
    return ctx;
}

// plays the running game on to its last reveal, where it counts as over (players may look at their results)
function toLastReveal(s, host) {
    while (s.round + 1 < s.guesses.length) {
        s.handle(host, { type: "endRound" });
        readyAll(s, s.round + 1);
        s.handle(host, { type: "next" });
    }
    s.handle(host, { type: "endRound" });
}

// the host plays the game through to the final ranking
function finish(s, host) {
    toLastReveal(s, host);
    s.handle(host, { type: "next" });
}

test("create makes the creator host and player", () => {
    const { host, last } = setup();
    assert.equal(last(host, "welcome").isHost, true);
    assert.equal(last(host, "welcome").code, "ABCD");
    const state = last(host, "state");
    assert.equal(state.phase, "lobby");
    assert.deepEqual(state.players.map(p => p.name), ["Hans"]);
    assert.deepEqual(state.settings, CLASSIC);
});

test("create rejects invalid settings", () => {
    const sent = [];
    const s = new Session("ABCD", { send: (conn, msg) => sent.push(msg) });
    assert.equal(s.create({}, { name: "Hans", settings: { mode: "classic", timer: "0", rounds: 3 } }), false);
    assert.equal(sent[0].code, "INVALID");
});

test("join adds a player and broadcasts state", () => {
    const { host, guest, last } = withGuest();
    assert.equal(last(guest, "welcome").isHost, false);
    assert.deepEqual(last(host, "state").players.map(p => p.name), ["Hans", "Max"]);
});

test("names are unique ignoring case, spaces and control chars", () => {
    const { s, last } = withGuest();
    const other = {};
    assert.equal(s.join(other, { name: " max\u0007" }), false);
    assert.equal(s.join({}, { name: "Max\u200b" }), false);
    assert.equal(last(other, "error").code, "NAME_TAKEN");
});

test("session is capped at MAX_PLAYERS", () => {
    const { s, last } = setup();
    for (let i = 1; i < MAX_PLAYERS; i++) assert.equal(s.join({}, { name: `P${i}` }), true);
    const late = {};
    assert.equal(s.join(late, { name: "Late" }), false);
    assert.equal(last(late, "error").code, "SESSION_FULL");
});

test("new players cannot join a running game", () => {
    const { s, last } = started();
    const late = {};
    assert.equal(s.join(late, { name: "Late" }), false);
    assert.equal(last(late, "error").code, "GAME_RUNNING");
});

test("until round 1 runs, players can join like in the lobby; who left during the countdown keeps their place, offline", () => {
    const { s, host, guest, last, advance } = withGuest();
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(guest, { type: "leave" });
    assert.deepEqual(last(host, "state").players.map(p => [p.name, p.connected]), [["Hans", true], ["Max", false]]);
    // back under the same name without the token (another device) takes the place over, and someone new joins:
    // both get round 1's images to load
    const again = {};
    const late = {};
    assert.equal(s.join(again, { name: "Max" }), true);
    assert.equal(s.join(late, { name: "Late" }), true);
    assert.deepEqual([last(again, "prepare").index, last(late, "prepare").index], [0, 0]);
    readyAll(s, 0);
    advance(COUNTDOWN_FORCED_MS);
    s.tick();
    assert.equal(s.phase, "round");
    assert.equal(last(again, "round").index, 0);
    assert.deepEqual(last(host, "state").players.map(p => [p.name, p.connected]), [["Hans", true], ["Max", true], ["Late", true]]);
});

test("only the host may control the game", () => {
    const { s, guest, last } = withGuest();
    s.handle(guest, { type: "start", guesses: GUESSES });
    assert.equal(last(guest, "error").code, "NOT_HOST");
    assert.equal(s.phase, "lobby");
});

test("host can change settings in the lobby", () => {
    const { s, host, guest, last } = withGuest();
    s.handle(host, { type: "settings", settings: { mode: "mapFinder", timer: 20, rounds: 5, next: 15 } });
    assert.deepEqual(last(guest, "state").settings, { mode: "mapFinder", timer: 20, rounds: 5, next: 15, keepCode: false, speedBonus: false });
});

test("settings without next, keepCode or speedBonus (an older cached client) leave the next round to the host, renew the code and give no bonus", () => {
    const { last, host } = setup({ mode: "classic", timer: 0, rounds: 3 });
    assert.equal(last(host, "state").settings.next, 0);
    assert.equal(last(host, "state").settings.keepCode, false);
    assert.equal(last(host, "state").settings.speedBonus, false);
});

test("start rejects guesses that do not match settings.rounds", () => {
    const { s, host, last } = withGuest();
    s.handle(host, { type: "start", guesses: GUESSES.slice(0, 2) });
    assert.equal(last(host, "error").code, "INVALID");
    assert.equal(s.phase, "lobby");
});

test("round message never leaks the solution", () => {
    const { guest, last } = started();
    const round = last(guest, "round");
    assert.deepEqual(round, { type: "round", index: 0, total: 3, url: "/img/guesses/a.webp", submitter: "Dan", deadline: null, map: "Narva" });
});

test("mapFinder round hides the map name", () => {
    const { guest, last } = started({ mode: "mapFinder", timer: 0, rounds: 3 });
    assert.equal(last(guest, "round").map, null);
});

test("state is sent before round so clients know their answered flag, and the next round is announced after it", () => {
    const { sent, guest } = started();
    const types = sent.filter(x => x.conn === guest).map(x => x.msg.type);
    assert.deepEqual(types.slice(-3), ["state", "round", "prepare"]);
});

test("round ends when every connected player answered", () => {
    const { s, host, guest, last } = started();
    s.handle(host, { type: "answer", index: s.round, lat: -100, lng: 200 });
    assert.equal(s.phase, "round");
    assert.equal(last(guest, "state").players.find(p => p.name === "Hans").answered, true);
    s.handle(guest, { type: "answer", index: s.round, lat: -2800, lng: 2800 });
    assert.equal(s.phase, "reveal");
    const reveal = last(guest, "reveal");
    assert.deepEqual(reveal.solution, { map: "Narva", url: "/img/guesses/a.webp", lat: -100, lng: 200 });
    const hans = reveal.results.find(r => r.name === "Hans");
    const max = reveal.results.find(r => r.name === "Max");
    assert.equal(hans.points, 100);
    assert.equal(hans.score, 100);
    assert.equal(max.points, 0);
    assert.equal(reveal.results[0].name, "Hans");
});

test("a disconnected player stops blocking the round once the reconnect window passed, and scores 0", () => {
    const { s, host, guest, last, advance } = started();
    s.disconnect(guest);
    s.handle(host, { type: "answer", index: s.round, lat: -100, lng: 200 });
    advance(RECONNECT_MS - 1);
    s.tick();
    assert.equal(s.phase, "round");
    advance(1);
    s.tick();
    assert.equal(s.phase, "reveal");
    const max = last(host, "reveal").results.find(r => r.name === "Max");
    assert.deepEqual([max.points, max.lat, max.distance], [0, null, null]);
});

test("deadline plus grace ends the round via tick", () => {
    const { s, advance } = started({ mode: "classic", timer: 15, rounds: 3 });
    advance(15999);
    s.tick();
    assert.equal(s.phase, "round");
    advance(1);
    s.tick();
    assert.equal(s.phase, "reveal");
});

test("answer inside the grace period counts, answer after reveal is rejected", () => {
    const { s, host, guest, last, advance } = started({ mode: "classic", timer: 15, rounds: 3 });
    advance(15500);
    s.handle(guest, { type: "answer", index: s.round, lat: -100, lng: 200 });
    s.handle(host, { type: "answer", index: s.round, lat: -100, lng: 200 });
    assert.equal(s.phase, "reveal");
    assert.equal(last(guest, "reveal").results.find(r => r.name === "Max").points, 100);
    s.handle(guest, { type: "answer", index: s.round, lat: -100, lng: 200 });
    assert.equal(last(guest, "error").code, "INVALID");
    s.handle(host, { type: "next" });
    assert.equal(last(guest, "state").players.find(p => p.name === "Max").answered, false);
});

test("a second answer in the same round is rejected", () => {
    const { s, host, last } = started();
    s.handle(host, { type: "answer", index: s.round, lat: 1, lng: 1 });
    s.handle(host, { type: "answer", index: s.round, lat: -100, lng: 200 });
    assert.equal(last(host, "error").code, "INVALID");
});

test("host can end a round early", () => {
    const { s, host } = started();
    s.handle(host, { type: "endRound" });
    assert.equal(s.phase, "reveal");
});

test("host cannot end a timed round early; it ends when the timer runs out", () => {
    const { s, host, last, advance } = started({ mode: "classic", timer: 60, rounds: 3 });
    s.handle(host, { type: "endRound" });
    assert.equal(s.phase, "round");
    assert.equal(last(host, "error").code, "INVALID");
    advance(61_000);
    s.tick();
    assert.equal(s.phase, "reveal");
});

test("speed bonus: the server times each answer against its own deadline and adds it to the score", () => {
    const { s, host, guest, last, advance } = started({ mode: "classic", timer: 60, rounds: 3, speedBonus: true });
    // a perfect answer with 45 of 60 s left: 25 × 0.75
    advance(15_000);
    s.handle(host, { type: "answer", index: s.round, lat: -100, lng: 200 });
    // just as perfect, but in the grace second after the deadline
    advance(45_500);
    s.handle(guest, { type: "answer", index: s.round, lat: -100, lng: 200 });
    const results = last(host, "reveal").results;
    const hans = results.find(r => r.name === "Hans");
    const max = results.find(r => r.name === "Max");
    assert.deepEqual([hans.points, hans.bonus, hans.score], [100, 19, 119]);
    assert.deepEqual([max.points, max.bonus, max.score], [100, 0, 100]);
});

test("speed bonus: none without the option, and none for whoever did not answer", () => {
    const { s, host, last, advance } = started({ mode: "classic", timer: 60, rounds: 3 });
    s.handle(host, { type: "answer", index: s.round, lat: -100, lng: 200 });
    advance(61_000);
    s.tick();
    const results = last(host, "reveal").results;
    assert.deepEqual(results.map(r => [r.name, r.bonus, r.score]), [["Hans", 0, 100], ["Max", 0, 0]]);
});

test("speed bonus: off whenever the round has no timer, so the lobby never shows it for chill", () => {
    const { s, host, last } = setup({ ...CLASSIC, speedBonus: true });
    assert.equal(last(host, "state").settings.speedBonus, false);
    s.handle(host, { type: "settings", settings: { ...CLASSIC, timer: 15, speedBonus: true } });
    assert.equal(last(host, "state").settings.speedBonus, true);
});

test("mapFinder answers are scored by map name", () => {
    const { s, host, guest, last } = started({ mode: "mapFinder", timer: 0, rounds: 3 });
    s.handle(host, { type: "answer", index: s.round, mapName: "narv" });
    s.handle(guest, { type: "answer", index: s.round, mapName: "kohat" });
    const results = last(host, "reveal").results;
    assert.equal(results.find(r => r.name === "Hans").points, 100);
    assert.equal(results.find(r => r.name === "Max").points, 0);
    assert.equal(results.find(r => r.name === "Hans").lat, null);
});

test("reconnect during a round restores the player and resends the round", () => {
    const { s, guest, last } = started();
    const token = last(guest, "welcome").token;
    s.disconnect(guest);
    const phone = { id: "phone" };
    assert.equal(s.join(phone, { name: "ignored", token }), true);
    assert.equal(last(phone, "welcome").playerId, last(guest, "welcome").playerId);
    assert.equal(last(phone, "round").index, 0);
    assert.equal(last(phone, "state").players.find(p => p.name === "Max").connected, true);
});

test("reconnect during reveal gets reveal", () => {
    const { s, host, guest, last } = started();
    const token = last(guest, "welcome").token;
    s.disconnect(guest);
    s.handle(host, { type: "endRound" });
    const phone = {};
    s.join(phone, { token });
    assert.equal(last(phone, "reveal").index, 0);
    assert.equal(last(phone, "round"), undefined);
});

test("host reconnect keeps host role and score", () => {
    const { s, host, guest, last } = started();
    s.handle(host, { type: "answer", index: s.round, lat: -100, lng: 200 });
    s.handle(guest, { type: "answer", index: s.round, lat: -100, lng: 200 });
    const token = last(host, "welcome").token;
    s.disconnect(host);
    const reloaded = {};
    s.join(reloaded, { token });
    assert.equal(last(reloaded, "welcome").isHost, true);
    assert.equal(last(reloaded, "state").players.find(p => p.name === "Hans").score, 100);
    readyAll(s, 1);
    s.handle(reloaded, { type: "next" });
    assert.equal(s.phase, "round");
});

test("final ranking with a tie has two winners, lobby resets", () => {
    const { s, host, guest, last } = started();
    for (let i = 0; i < 3; i++) {
        s.handle(host, { type: "answer", index: s.round, lat: GUESSES[i].lat, lng: GUESSES[i].lng });
        s.handle(guest, { type: "answer", index: s.round, lat: GUESSES[i].lat, lng: GUESSES[i].lng });
        readyAll(s, s.round + 1);
        s.handle(host, { type: "next" });
    }
    assert.equal(s.phase, "final");
    const final = last(guest, "final");
    assert.deepEqual(final.ranking.map(r => r.score), [300, 300]);
    assert.equal(final.winners.length, 2);
    s.handle(host, { type: "lobby" });
    const state = last(guest, "state");
    assert.equal(state.phase, "lobby");
    assert.deepEqual(state.players.map(p => p.score), [0, 0]);
});

test("by default the reveal waits for the host's NEXT, however long it takes", () => {
    const { s, host, last, advance } = started();
    s.handle(host, { type: "endRound" });
    assert.equal(last(host, "state").nextAt, null);
    advance(10 * 60_000);
    s.tick();
    assert.equal(s.phase, "reveal");
});

test("with auto next the reveal moves on by itself after next seconds, and the host cannot skip it", () => {
    const { s, host, guest, last, advance } = started({ mode: "classic", timer: 0, rounds: 3, next: 15 });
    s.handle(host, { type: "endRound" });
    assert.equal(last(guest, "state").nextAt, s.now() + 15_000);
    s.handle(host, { type: "next" });
    assert.equal(last(host, "error").code, "INVALID");
    readyAll(s, 1);
    advance(14_999);
    s.tick();
    assert.equal(s.phase, "reveal");
    advance(1);
    s.tick();
    assert.equal(s.phase, "round");
    assert.equal(s.round, 1);
    assert.equal(last(guest, "state").nextAt, null);
});

test("with auto next the last reveal moves everyone on to the final ranking", () => {
    const { s, host, guest, last, advance } = started({ mode: "classic", timer: 0, rounds: 3, next: 5 });
    for (let i = 0; i < 3; i++) {
        readyAll(s, s.round + 1);
        s.handle(host, { type: "endRound" });
        advance(5_000);
        s.tick();
    }
    assert.equal(s.phase, "final");
    assert.ok(last(guest, "final"));
});

test("back to the lobby is allowed from the last reveal (players may already be on their results), not earlier", () => {
    const { s, host } = started();
    s.handle(host, { type: "endRound" });
    s.handle(host, { type: "lobby" });
    assert.equal(s.phase, "reveal");
    for (let i = 0; i < 2; i++) {
        readyAll(s, s.round + 1);
        s.handle(host, { type: "next" });
        s.handle(host, { type: "endRound" });
    }
    s.handle(host, { type: "lobby" });
    assert.equal(s.phase, "lobby");
});

test("any player goes back to the lobby on their own: the others stay on their results until they follow", () => {
    const { s, host, guest, last } = started();
    finish(s, host);
    s.handle(guest, { type: "lobby" });
    assert.equal(s.phase, "lobby");
    assert.deepEqual(last(host, "state").players.map(p => [p.name, p.back]), [["Hans", false], ["Max", true]]);
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.handle(host, { type: "lobby" });
    // following does not start the lobby over: the guest stays ready
    assert.deepEqual(last(host, "state").players.map(p => [p.name, p.back, p.lobbyReady]), [["Hans", true, false], ["Max", true, true]]);
});

test("going back to the lobby mid-game is refused for guests as for the host", () => {
    const { s, guest, last } = started();
    s.handle(guest, { type: "lobby" });
    assert.equal(last(guest, "error").code, "INVALID");
    assert.equal(s.phase, "round");
});

test("whoever joins the lobby after a game is in it, not on any results", () => {
    const { s, host, guest, last } = started();
    finish(s, host);
    s.handle(guest, { type: "lobby" });
    s.join({}, { name: "Ana" });
    assert.equal(last(host, "state").players.find(p => p.name === "Ana").back, true);
});

test("a host still on the results HANDOVER_MS after the first player came back hands over to whoever came back first", () => {
    const { s, host, guest, last, advance, begin } = withGuest();
    const ana = {};
    s.join(ana, { name: "Ana" });
    begin();
    finish(s, host);
    s.handle(ana, { type: "lobby" });
    advance(5_000);
    s.handle(guest, { type: "lobby" });
    advance(HANDOVER_MS - 5_001);
    s.tick();
    assert.equal(last(guest, "state").hostId, last(host, "welcome").playerId);
    advance(1);
    s.tick();
    assert.equal(last(guest, "state").hostId, last(ana, "welcome").playerId);
    // coming back later, the old host is a guest like the others
    s.handle(host, { type: "lobby" });
    assert.equal(last(host, "state").hostId, last(ana, "welcome").playerId);
});

test("a host back in the lobby in time keeps the role, however long the others waited", () => {
    const { s, host, guest, last, advance } = started();
    finish(s, host);
    s.handle(guest, { type: "lobby" });
    advance(HANDOVER_MS - 1);
    s.handle(host, { type: "lobby" });
    advance(10 * 60_000);
    s.tick();
    assert.equal(s.hostId, last(host, "welcome").playerId);
});

test("a called-off start leaves nobody on the results: the start took everyone along", () => {
    const { s, host, last } = started();
    finish(s, host);
    s.handle(host, { type: "lobby" });
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(host, { type: "cancelStart" });
    assert.equal(last(host, "state").players.find(p => p.name === "Max").back, true);
});

test("watchers receive state and rounds but cannot act", () => {
    const { s, last, begin } = withGuest();
    const tv = {};
    assert.equal(s.watch(tv), true);
    assert.equal(last(tv, "state").phase, "lobby");
    begin();
    assert.equal(last(tv, "round").index, 0);
    s.handle(tv, { type: "answer", index: s.round, lat: 1, lng: 1 });
    assert.equal(last(tv, "error").code, "INVALID");
});

test("unknown message types are rejected", () => {
    const { s, host, last } = setup();
    s.handle(host, { type: "explode" });
    assert.equal(last(host, "error").code, "INVALID");
});

test("isIdle after inactivity", () => {
    const { s, host, advance } = setup();
    s.disconnect(host);
    advance(1000);
    assert.equal(s.isIdle(5000), false);
    advance(5000);
    assert.equal(s.isIdle(5000), true);
});

test("a late answer for the previous round is rejected and does not use up the next round", () => {
    const { s, host, guest, last } = started();
    s.handle(host, { type: "answer", index: 0, lat: -100, lng: 200 });
    s.handle(host, { type: "endRound" });
    readyAll(s, 1);
    s.handle(host, { type: "next" });
    s.handle(guest, { type: "answer", index: 0, lat: -300, lng: 400 });
    assert.equal(last(guest, "error").code, "INVALID");
    s.handle(guest, { type: "answer", index: 1, lat: -300, lng: 400 });
    s.handle(host, { type: "answer", index: 1, lat: -300, lng: 400 });
    assert.equal(last(guest, "reveal").results.find(r => r.name === "Max").points, 100);
});

test("an answer without a round index is rejected", () => {
    const { s, host, last } = started();
    s.handle(host, { type: "answer", lat: -100, lng: 200 });
    assert.equal(last(host, "error").code, "INVALID");
});

test("leaving the lobby frees the name and the slot", () => {
    const { s, host, guest, last } = withGuest();
    s.handle(guest, { type: "leave" });
    assert.deepEqual(last(host, "state").players.map(p => p.name), ["Hans"]);
    const again = {};
    assert.equal(s.join(again, { name: "Max" }), true);
});

test("a kicked player is told and may come back only after KICK_WAIT_MS: not on that device, not under that name", () => {
    const { s, host, guest, last, advance } = withGuest();
    const { playerId, token } = last(guest, "welcome");
    s.handle(host, { type: "kick", playerId });
    assert.deepEqual(last(guest, "error"), { type: "error", code: "KICKED", seconds: KICK_WAIT_MS / 1000 });
    assert.deepEqual(last(host, "state").players.map(p => p.name), ["Hans"]);
    // offline at the kick, they never got the message: their reconnect must not quietly undo it, whatever name it brings
    const back = {};
    assert.equal(s.join(back, { name: "Maxi", token }), false);
    assert.equal(last(back, "error").code, "KICKED");
    // another device under the same name (any case) is told how long is left
    advance(10 * 1000);
    const other = {};
    assert.equal(s.join(other, { name: "max" }), false);
    assert.deepEqual(last(other, "error"), { type: "error", code: "KICKED", seconds: 20 });
    // the slot is free for anybody else
    assert.equal(s.join({}, { name: "Ana" }), true);
    advance(KICK_WAIT_MS - 10 * 1000);
    const again = {};
    assert.equal(s.join(again, { name: "Max", token }), true);
    assert.notEqual(last(again, "welcome").token, token);
});

test("only the host kicks, never themselves, and only in the lobby", () => {
    const { s, host, guest, last } = withGuest();
    const hostId = last(host, "welcome").playerId;
    const guestId = last(guest, "welcome").playerId;
    s.handle(guest, { type: "kick", playerId: hostId });
    assert.equal(last(guest, "error").code, "NOT_HOST");
    s.handle(host, { type: "kick", playerId: hostId });
    assert.equal(last(host, "error").code, "INVALID");
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(host, { type: "kick", playerId: guestId });
    assert.equal(last(host, "error").code, "INVALID");
    assert.equal(s.players.size, 2);
});

test("the host can make a guest in the lobby host and is a guest then", () => {
    const { s, host, guest, last } = withGuest();
    const guestId = last(guest, "welcome").playerId;
    s.handle(host, { type: "promote", playerId: guestId });
    assert.equal(last(host, "state").hostId, guestId);
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.equal(last(host, "error").code, "NOT_HOST");
    s.handle(guest, { type: "start", guesses: GUESSES });
    assert.equal(s.phase, "loading");
});

test("only the host promotes, never themselves, and only in the lobby", () => {
    const { s, host, guest, last } = withGuest();
    const hostId = last(host, "welcome").playerId;
    const guestId = last(guest, "welcome").playerId;
    s.handle(guest, { type: "promote", playerId: guestId });
    assert.equal(last(guest, "error").code, "NOT_HOST");
    s.handle(host, { type: "promote", playerId: hostId });
    assert.equal(last(host, "error").code, "INVALID");
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(host, { type: "promote", playerId: guestId });
    assert.equal(last(host, "error").code, "INVALID");
    assert.equal(s.hostId, hostId);
});

test("promoting someone gone, offline or still on the results does nothing: they may have left during the question", () => {
    const { s, host, guest, last, all } = started();
    const hostId = last(host, "welcome").playerId;
    const ana = {};
    finish(s, host);
    s.handle(host, { type: "lobby" });
    s.join(ana, { name: "Ana" });
    const anaId = last(ana, "welcome").playerId;
    s.disconnect(ana);
    const before = all(host, "error").length;
    s.handle(host, { type: "promote", playerId: last(guest, "welcome").playerId });
    s.handle(host, { type: "promote", playerId: anaId });
    s.handle(host, { type: "promote", playerId: "nobody" });
    assert.equal(s.hostId, hostId);
    assert.equal(all(host, "error").length, before);
});

test("leaving a running game keeps the player's score but marks them offline", () => {
    const { s, host, guest, last } = started();
    s.handle(guest, { type: "leave" });
    const max = last(host, "state").players.find(p => p.name === "Max");
    assert.equal(max.connected, false);
    s.handle(host, { type: "answer", index: 0, lat: -100, lng: 200 });
    assert.equal(s.phase, "reveal");
});

test("a host who leaves hands the host role to the next connected player", () => {
    const { s, host, guest, last, begin } = withGuest();
    s.handle(host, { type: "leave" });
    const state = last(guest, "state");
    assert.equal(state.hostId, last(guest, "welcome").playerId);
    assert.deepEqual(state.players.map(p => p.name), ["Max"]);
    s.join({}, { name: "Ana" });
    begin(guest);
    assert.equal(s.phase, "round");
});

test("a host who leaves mid-game hands over so the game can continue", () => {
    const { s, host, guest, last } = started();
    s.handle(host, { type: "leave" });
    s.handle(guest, { type: "answer", index: 0, lat: -100, lng: 200 });
    assert.equal(s.phase, "reveal");
    readyAll(s, 1);
    s.handle(guest, { type: "next" });
    assert.equal(s.phase, "round");
    assert.equal(last(guest, "state").players.find(p => p.name === "Hans").connected, false);
});

test("a host whose connection drops in the lobby stays host and can come back", () => {
    const { s, host, guest, last } = withGuest();
    const token = last(host, "welcome").token;
    s.disconnect(host);
    assert.notEqual(last(guest, "state").hostId, last(guest, "welcome").playerId);
    const back = {};
    s.join(back, { token });
    assert.equal(last(back, "welcome").isHost, true);
});

test("a lobby guest whose connection drops keeps their place and can still get into the game", () => {
    const { s, host, guest, last, begin } = withGuest();
    const token = last(guest, "welcome").token;
    s.disconnect(guest);
    assert.deepEqual(last(host, "state").players.map(p => [p.name, p.connected]), [["Hans", true], ["Max", false]]);
    s.join({}, { name: "Ana" });
    begin();
    const phone = {};
    assert.equal(s.join(phone, { name: "Max", token }), true);
    assert.equal(last(phone, "round").index, 0);
});

test("joining the lobby with the name of a player who dropped out takes over their place", () => {
    const { s, host, last } = setup();
    for (let i = 1; i < MAX_PLAYERS; i++) s.join({ id: i }, { name: `P${i}` });
    s.disconnect(s.findPlayer(p => p.name === "P1").conn);
    const again = {};
    assert.equal(s.join(again, { name: "p1" }), true);
    assert.deepEqual(last(host, "state").players.map(p => p.name).filter(n => n.toLowerCase() === "p1"), ["p1"]);
    assert.equal(s.join({}, { name: "P2" }), false);
});

test("a session with connected players or watchers is never idle", () => {
    const { s, host, advance } = setup();
    const tv = {};
    s.watch(tv);
    advance(60 * 60 * 1000);
    assert.equal(s.isIdle(5000), false);
    s.disconnect(host);
    advance(60 * 60 * 1000);
    assert.equal(s.isIdle(5000), false);
    s.disconnect(tv);
    advance(4000);
    assert.equal(s.isIdle(5000), false);
    advance(2000);
    assert.equal(s.isIdle(5000), true);
});

test("absurd answer coordinates are clamped to the map", () => {
    const { s, host, guest, last } = started();
    s.handle(host, { type: "answer", index: 0, lat: 1e200, lng: -1e200 });
    s.handle(guest, { type: "answer", index: 0, lat: -1e200, lng: 1e200 });
    const size = mapSize("Narva");
    const [hans, max] = ["Hans", "Max"].map(n => last(host, "reveal").results.find(r => r.name === n));
    assert.deepEqual([hans.lat, hans.lng, max.lat, max.lng], [0, 0, -size, size]);
});

test("a player whose connection drops for a moment does not end the round", () => {
    const { s, host, guest, last, advance } = started();
    const token = last(guest, "welcome").token;
    s.handle(host, { type: "answer", index: 0, lat: -100, lng: 200 });
    s.disconnect(guest);
    advance(1000);
    s.tick();
    assert.equal(s.phase, "round");
    const phone = {};
    s.join(phone, { token });
    s.handle(phone, { type: "answer", index: 0, lat: -100, lng: 200 });
    assert.equal(last(phone, "reveal").results.find(r => r.name === "Max").points, 100);
});

test("a host who is gone longer than a reload hands the host role to a connected player", () => {
    const { s, host, guest, last, advance } = started();
    s.disconnect(host);
    advance(RECONNECT_MS - 1);
    s.tick();
    assert.notEqual(last(guest, "state").hostId, last(guest, "welcome").playerId);
    advance(1);
    s.tick();
    assert.equal(last(guest, "state").hostId, last(guest, "welcome").playerId);
    s.handle(guest, { type: "endRound" });
    assert.equal(s.phase, "reveal");
});

test("when nobody connected holds the host role, the next player who is there gets it", () => {
    const { s, host, last, begin } = setup();
    const tv = {};
    s.watch(tv);
    s.handle(host, { type: "leave" });
    const phone = {};
    s.join(phone, { name: "Hans" });
    s.tick();
    assert.equal(last(tv, "state").hostId, last(phone, "welcome").playerId);
    s.join({}, { name: "Max" });
    begin(phone);
    assert.equal(s.phase, "round");
});

test("a second connection with the same token takes over, and the first one is told", () => {
    const { s, guest, last } = withGuest();
    const tab = {};
    s.join(tab, { token: last(guest, "welcome").token });
    assert.equal(last(guest, "error").code, "REPLACED");
    assert.equal(last(tab, "welcome").playerId, last(guest, "welcome").playerId);
});

test("back in the lobby, players who left or dropped out during the game are gone", () => {
    const { s, host, guest, last } = started();
    s.handle(guest, { type: "leave" });
    for (let i = 0; i < 3; i++) {
        s.handle(host, { type: "endRound" });
        readyAll(s, s.round + 1);
        s.handle(host, { type: "next" });
    }
    assert.equal(s.phase, "final");
    s.handle(host, { type: "lobby" });
    assert.deepEqual(last(host, "state").players.map(p => p.name), ["Hans"]);
    assert.equal(s.join({}, { name: "Max" }), true);
});

// ===== LOADING: everyone sees a round at the same moment =====

test("a round is held back until every connected player has its images, and its clock starts only then", () => {
    const { s, host, guest, last, advance } = withGuest({ mode: "classic", timer: 15, rounds: 3 });
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.equal(last(guest, "state").phase, "loading");
    assert.deepEqual(last(guest, "prepare"), { type: "prepare", index: 0, url: "/img/guesses/a.webp", map: "Narva" });
    assert.equal(last(guest, "round"), undefined);
    s.handle(host, { type: "answer", index: 0, lat: -100, lng: 200 });
    assert.equal(last(host, "error").code, "INVALID");
    advance(COUNTDOWN_READY_MS);
    s.handle(host, { type: "ready", index: 0 });
    assert.deepEqual(last(guest, "state").players.map(p => [p.name, p.ready, p.stalled]), [["Hans", true, false], ["Max", false, false]]);
    advance(3000);
    s.handle(guest, { type: "ready", index: 0 });
    assert.equal(s.phase, "round");
    assert.equal(last(guest, "round").deadline, 1000 + COUNTDOWN_READY_MS + 3000 + 15000);
});

test("loading waits at most LOAD_FIRST_MS, then LOAD_MS; who missed it is not waited for until they report back", () => {
    const { s, host, guest, last, advance } = withGuest();
    const max = () => s.findPlayer(p => p.name === "Max");
    const skip = (i) => { s.handle(host, { type: "endRound" }); s.handle(host, { type: "ready", index: i }); s.handle(host, { type: "next" }); };
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(host, { type: "ready", index: 0 });
    advance(LOAD_FIRST_MS - 1);
    s.tick();
    assert.equal(s.phase, "loading");
    advance(1);
    s.tick();
    assert.equal(s.phase, "round");
    assert.equal(max().stalled, true);
    // the locked phone does not hold up the next round; a ready, even a late one, brings Max back into the waiting
    skip(1);
    assert.equal(s.phase, "round");
    s.handle(guest, { type: "ready", index: 1 });
    skip(2);
    assert.equal(s.phase, "loading");
    advance(LOAD_MS - 1);
    s.tick();
    assert.equal(s.phase, "loading");
    advance(1);
    s.tick();
    assert.equal(max().stalled, true);
    // coming back counts as reporting back too
    s.disconnect(guest);
    s.join({}, { token: last(guest, "welcome").token });
    assert.equal(max().stalled, false);
});

test("preloaded rounds start at once and announce the next; a new game waits for everyone again", () => {
    const { s, host, guest, sent, all } = started();
    s.handle(host, { type: "endRound" });
    readyAll(s, 1);
    const before = sent.length;
    s.handle(host, { type: "next" });
    const mine = sent.slice(before).filter(x => x.conn === guest).map(x => x.msg);
    assert.deepEqual(mine.map(m => m.type), ["state", "round", "prepare"]);
    assert.equal(mine[0].phase, "round");
    s.handle(host, { type: "endRound" });
    readyAll(s, 2);
    s.handle(host, { type: "next" });
    s.handle(host, { type: "endRound" });
    s.handle(host, { type: "next" });
    assert.equal(s.phase, "final");
    // the last round announces nothing; a ready after the game is ignored without an error
    assert.deepEqual(all(guest, "prepare").map(m => m.index), [0, 1, 2]);
    s.handle(guest, { type: "ready", index: 2 });
    assert.deepEqual(all(guest, "error"), []);
    s.handle(host, { type: "lobby" });
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.equal(s.phase, "loading");
});

test("a player who drops or leaves while loading is not waited for", () => {
    const { s, host, guest, advance } = withGuest();
    const ida = {};
    s.join(ida, { name: "Ida" });
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.handle(ida, { type: "lobbyReady", ready: true });
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(host, { type: "ready", index: 0 });
    advance(COUNTDOWN_READY_MS);
    s.disconnect(guest);
    s.tick();
    assert.equal(s.phase, "loading");
    s.handle(ida, { type: "leave" });
    assert.equal(s.phase, "round");
});

test("with everyone away, loading waits; the first one back gets a fresh wait that still ends after LOAD_MS", () => {
    const { s, host, guest, last, advance } = withGuest();
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.handle(host, { type: "start", guesses: GUESSES });
    s.disconnect(host);
    s.disconnect(guest);
    advance(LOAD_FIRST_MS + 1000);
    s.tick();
    assert.equal(s.phase, "loading");
    s.join({}, { token: last(host, "welcome").token });
    s.tick();
    assert.equal(s.phase, "loading");
    assert.equal(s.findPlayer(p => p.name === "Hans").stalled, false);
    advance(LOAD_MS - 1);
    s.tick();
    assert.equal(s.phase, "loading");
    advance(1);
    s.tick();
    assert.equal(s.phase, "round");
});

test("a player who reconnects gets the images again: while loading without extending the time, later for the next round", () => {
    const { s, host, guest, last, advance } = withGuest();
    const back = () => { const conn = {}; s.disconnect(s.findPlayer(p => p.name === "Max").conn); s.join(conn, { token: last(guest, "welcome").token }); return conn; };
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(host, { type: "ready", index: 0 });
    advance(5000);
    let phone = back();
    assert.equal(last(phone, "prepare").index, 0);
    advance(LOAD_FIRST_MS - 5000 - 1);
    s.tick();
    assert.equal(s.phase, "loading");
    advance(1);
    s.tick();
    assert.equal(s.phase, "round");
    phone = back();
    assert.deepEqual([last(phone, "round").index, last(phone, "prepare").index], [0, 1]);
    s.handle(phone, { type: "ready", index: 1 });
    s.handle(host, { type: "endRound" });
    phone = back();
    assert.deepEqual([last(phone, "reveal").index, last(phone, "prepare").index], [0, 1]);
    // a reloaded page lost its preloaded images, so the next round waits for it again
    s.handle(host, { type: "ready", index: 1 });
    s.handle(host, { type: "next" });
    assert.equal(s.phase, "loading");
    s.handle(phone, { type: "ready", index: 1 });
    assert.equal(s.phase, "round");
});

test("odd ready messages are ignored silently: outside a game, not announced, stale, not a whole number, duplicate", () => {
    const { s, host, guest, sent, all } = withGuest();
    s.handle(guest, { type: "ready", index: 0 });
    s.handle(host, { type: "start", guesses: GUESSES });
    const before = sent.length;
    s.handle(guest, { type: "ready", index: 1 });
    s.handle(guest, { type: "ready", index: 2 });
    s.handle(guest, { type: "ready", index: "0" });
    s.handle(guest, { type: "ready", index: 0.5 });
    s.handle(guest, { type: "ready" });
    assert.equal(sent.length, before);
    assert.equal(s.findPlayer(p => p.name === "Max").ready, -1);
    s.handle(guest, { type: "ready", index: 0 });
    const counted = sent.length;
    s.handle(guest, { type: "ready", index: 0 });
    assert.equal(sent.length, counted);
    assert.deepEqual(all(guest, "error"), []);
});

test("watchers get the images to preload but are never waited for", () => {
    const { s, host, last, advance } = withGuest();
    s.handle(host, { type: "start", guesses: GUESSES });
    const tv = {};
    s.watch(tv);
    assert.deepEqual([last(tv, "state").phase, last(tv, "prepare").index], ["loading", 0]);
    readyAll(s, 0);
    advance(COUNTDOWN_FORCED_MS);
    s.tick();
    assert.equal(s.phase, "round");
    assert.equal(last(tv, "prepare").index, 1);
});

test("mapFinder never sends the map ahead, not even for preloading", () => {
    const { guest, all } = started({ mode: "mapFinder", timer: 0, rounds: 3 });
    assert.deepEqual(all(guest, "prepare").map(m => m.map), [null, null]);
});

// ===== LOBBY READY AND START COUNTDOWN =====

test("guests mark themselves ready in the lobby; odd marks and marks outside the lobby are ignored silently", () => {
    const { s, host, guest, sent, all, last } = withGuest();
    s.handle(guest, { type: "lobbyReady", ready: true });
    assert.deepEqual(last(host, "state").players.map(p => [p.name, p.lobbyReady]), [["Hans", false], ["Max", true]]);
    const before = sent.length;
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.handle(guest, { type: "lobbyReady", ready: "false" });
    s.handle(guest, { type: "lobbyReady" });
    assert.equal(sent.length, before);
    s.handle(guest, { type: "lobbyReady", ready: false });
    assert.equal(last(host, "state").players.find(p => p.name === "Max").lobbyReady, false);
    s.handle(host, { type: "start", guesses: GUESSES });
    const starting = sent.length;
    s.handle(guest, { type: "lobbyReady", ready: true });
    assert.equal(sent.length, starting);
    assert.deepEqual(all(guest, "error"), []);
});

test("changed settings take every ready back and tell those guests; the same settings again change nothing", () => {
    const { s, host, guest, all, last } = withGuest();
    const ida = { id: "ida" };
    s.join(ida, { name: "Ida" });
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.handle(host, { type: "settings", settings: CLASSIC });
    assert.equal(last(host, "state").players.find(p => p.name === "Max").lobbyReady, true);
    assert.deepEqual(all(guest, "unready"), []);
    s.handle(host, { type: "settings", settings: { ...CLASSIC, rounds: 5 } });
    assert.deepEqual(last(host, "state").players.map(p => [p.name, p.lobbyReady]), [["Hans", false], ["Max", false], ["Ida", false]]);
    assert.equal(all(guest, "unready").length, 1);
    assert.deepEqual(all(ida, "unready"), []);
});

test("every start counts down: 5 s when every connected guest is ready, otherwise 15 s", () => {
    const countdown = (prepare) => {
        const ctx = withGuest();
        prepare(ctx);
        ctx.s.handle(ctx.host, { type: "start", guesses: GUESSES });
        return ctx.last(ctx.host, "state").startsAt - 1000;
    };
    assert.equal(countdown(() => {}), COUNTDOWN_FORCED_MS);
    assert.equal(countdown(({ s, guest }) => s.handle(guest, { type: "lobbyReady", ready: true })), COUNTDOWN_READY_MS);
    // a guest whose connection dropped is not waited for; the host's START is their ready
    assert.equal(countdown(({ s, guest }) => {
        const ana = {};
        s.join(ana, { name: "Ana" });
        s.handle(ana, { type: "lobbyReady", ready: true });
        s.disconnect(guest);
    }), COUNTDOWN_READY_MS);
});

test("the host cannot start alone: at least one other player has to be connected, a watcher does not count", () => {
    const { s, host, guest, last } = withGuest();
    const token = last(guest, "welcome").token;
    s.watch({});
    s.disconnect(guest);
    assert.equal(last(host, "state").canStart, false);
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.equal(last(host, "error").code, "NO_PLAYERS");
    assert.equal(s.phase, "lobby");
    s.join({}, { name: "Max", token });
    assert.equal(last(host, "state").canStart, true);
    assert.equal(last(host, "state").allReady, false);
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.equal(s.phase, "loading");
});

test("round 1 never starts before the countdown ends, even with every image there", () => {
    const { s, host, guest, last, advance } = withGuest();
    s.handle(host, { type: "start", guesses: GUESSES });
    readyAll(s, 0);
    assert.equal(s.phase, "loading");
    advance(COUNTDOWN_FORCED_MS - 1);
    s.tick();
    assert.equal(s.phase, "loading");
    advance(1);
    s.tick();
    assert.equal(s.phase, "round");
    assert.equal(last(guest, "state").startsAt, null);
});

test("the long countdown is the whole wait for round 1: who still loads when it ends is not waited for", () => {
    const { s, host, advance } = withGuest();
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(host, { type: "ready", index: 0 });
    advance(COUNTDOWN_FORCED_MS - 1);
    s.tick();
    assert.equal(s.phase, "loading");
    advance(1);
    s.tick();
    assert.equal(s.phase, "round");
    assert.equal(s.findPlayer(p => p.name === "Max").stalled, true);
});

test("after a game nobody is ready any more, and the next game starts from the lobby only", () => {
    const { s, host, guest, last, begin } = withGuest();
    s.handle(guest, { type: "lobbyReady", ready: true });
    begin();
    for (let i = 0; i < 3; i++) {
        s.handle(host, { type: "endRound" });
        readyAll(s, s.round + 1);
        s.handle(host, { type: "next" });
    }
    assert.equal(s.phase, "final");
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.equal(last(host, "error").code, "INVALID");
    assert.equal(s.phase, "final");
    s.handle(host, { type: "lobby" });
    assert.equal(last(guest, "state").players.find(p => p.name === "Max").lobbyReady, false);
});

test("the host can call the start off until round 1 runs: back to the lobby, ready marks stay, who left stays offline", () => {
    const { s, host, guest, last, advance } = withGuest();
    const ida = {};
    s.join(ida, { name: "Ida" });
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.handle(ida, { type: "lobbyReady", ready: true });
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(guest, { type: "cancelStart" });
    assert.equal(last(guest, "error").code, "NOT_HOST");
    s.handle(ida, { type: "leave" });
    // the countdown is over, but a slow device is still waited for: that can be called off too
    s.handle(host, { type: "ready", index: 0 });
    advance(COUNTDOWN_READY_MS);
    s.tick();
    assert.equal(s.phase, "loading");
    s.handle(host, { type: "cancelStart" });
    const state = last(guest, "state");
    assert.deepEqual([state.phase, state.startsAt], ["lobby", null]);
    // Ida left during the countdown: offline like a dropped connection, she can come back with her token
    assert.deepEqual(state.players.map(p => [p.name, p.connected, p.lobbyReady]), [["Hans", true, false], ["Max", true, true], ["Ida", false, true]]);
    assert.deepEqual([...s.players.values()].map(p => [p.ready, p.stalled]), [[-1, false], [-1, false], [-1, false]]);
    // nothing keeps running in the lobby
    advance(LOAD_FIRST_MS);
    s.tick();
    assert.equal(s.phase, "lobby");
    // a new start counts down again; once round 1 runs, there is nothing left to call off
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.deepEqual([s.phase, last(guest, "prepare").index], ["loading", 0]);
    readyAll(s, 0);
    advance(COUNTDOWN_READY_MS);
    s.tick();
    assert.equal(s.phase, "round");
    s.handle(host, { type: "cancelStart" });
    assert.equal(last(host, "error").code, "INVALID");
    assert.equal(s.phase, "round");
});

test("a guest whose connection dropped in the lobby keeps their place through a called-off start", () => {
    const { s, host, guest, last, advance } = withGuest();
    const token = last(guest, "welcome").token;
    s.handle(guest, { type: "lobbyReady", ready: true });
    s.disconnect(guest);
    advance(RECONNECT_MS + 60 * 1000);
    s.tick();
    // the host is not alone, so the start goes through
    s.join({}, { name: "Ana" });
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.equal(s.phase, "loading");
    s.handle(host, { type: "cancelStart" });
    assert.deepEqual(last(host, "state").players.map(p => [p.name, p.connected, p.lobbyReady]), [["Hans", true, false], ["Max", false, true], ["Ana", true, false]]);
    // back with their token, even once the next start is running
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.equal(s.phase, "loading");
    const phone = {};
    assert.equal(s.join(phone, { token }), true);
    assert.equal(last(phone, "welcome").playerId, last(guest, "welcome").playerId);
});

test("a chat line reaches every player, cleaned and capped, but never a watcher", () => {
    const { s, host, guest, last, all } = withGuest();
    const tv = {};
    s.watch(tv);
    s.handle(guest, { type: "chat", text: "  gg\u200b  wp " });
    assert.deepEqual(last(host, "chat"), { type: "chat", id: last(guest, "welcome").playerId, name: "Max", text: "gg wp" });
    assert.equal(last(guest, "chat").text, "gg wp");
    s.handle(host, { type: "chat", text: "x".repeat(CHAT_MAX + 50) });
    assert.equal(last(guest, "chat").text, "x".repeat(CHAT_MAX));
    assert.equal(all(tv, "chat").length, 0);
});

test("empty chat lines and lines from whoever still guesses are ignored silently", () => {
    const { s, host, guest, said, last } = started();
    s.handle(guest, { type: "chat", text: "psst, it is Narva" });
    s.handle(guest, { type: "chat", text: 42 });
    s.handle(host, { type: "endRound" });
    s.handle(guest, { type: "chat", text: "  \u200b " });
    assert.deepEqual(said(host), []);
    assert.equal(last(guest, "error"), undefined);
    // nothing ignored used up the guest's turn
    s.handle(guest, { type: "chat", text: "close one" });
    assert.equal(last(host, "chat").text, "close one");
});

// Hans, Max and Ida in round 1, after a chat line in the lobby: one answer does not end the round
function threeInRound() {
    const ctx = withGuest();
    ctx.ida = {};
    ctx.s.join(ctx.ida, { name: "Ida" });
    ctx.s.handle(ctx.host, { type: "chat", text: "hi" });
    ctx.advance(CHAT_GAP_MS);
    ctx.begin();
    ctx.answer = (conn) => ctx.s.handle(conn, { type: "answer", index: ctx.s.round, lat: -100, lng: 200 });
    ctx.texts = ctx.said;
    return ctx;
}

test("while a round runs, whoever answered chats with the others who answered; who still guesses neither reads nor writes", () => {
    const { s, host, guest, ida, answer, texts, last } = threeInRound();
    answer(host);
    answer(ida);
    s.handle(guest, { type: "chat", text: "Narva?" });
    s.handle(host, { type: "chat", text: "gg" });
    assert.deepEqual([texts(host), texts(ida), texts(guest)], [["hi", "gg"], ["hi", "gg"], ["hi"]]);
    assert.equal(last(guest, "error"), undefined);
});

test("whoever answers gets the lines written while they guessed, and nothing twice", () => {
    const { s, host, guest, ida, answer, texts, advance } = threeInRound();
    answer(host);
    s.handle(host, { type: "chat", text: "a" });
    advance(CHAT_GAP_MS);
    s.handle(host, { type: "chat", text: "b" });
    answer(guest);
    assert.equal(s.phase, "round");
    assert.deepEqual(texts(guest), ["hi", "a", "b"]);
    assert.deepEqual(texts(ida), ["hi"]);
});

test("the reveal brings the round's lines to whoever never answered", () => {
    const { s, host, guest, ida, answer, texts } = threeInRound();
    answer(host);
    s.handle(host, { type: "chat", text: "a" });
    s.handle(host, { type: "endRound" });
    assert.equal(s.phase, "reveal");
    assert.deepEqual([texts(guest), texts(ida)], [["hi", "a"], ["hi", "a"]]);
});

test("back during a round, the history holds the round's lines only for whoever answered", () => {
    const { s, host, guest, ida, answer, last } = threeInRound();
    const rejoin = (conn) => {
        const { token } = last(conn, "welcome");
        s.disconnect(conn);
        const phone = {};
        s.join(phone, { token });
        return last(phone, "welcome").chat.filter(m => !m.system).map(m => m.text);
    };
    answer(host);
    answer(ida);
    s.handle(host, { type: "chat", text: "a" });
    assert.deepEqual([rejoin(guest), rejoin(ida)], [["hi"], ["hi", "a"]]);
});

test("the server allows a player a chat line every half CHAT_GAP_MS and tells whoever writes faster", () => {
    // the client itself waits the whole CHAT_GAP_MS: the other half is room for the network delaying one line more than the next
    const { s, host, guest, said, last, advance } = withGuest();
    s.handle(guest, { type: "chat", text: "a" });
    advance(CHAT_GAP_MS / 2 - 1);
    s.handle(guest, { type: "chat", text: "b" });
    assert.equal(last(guest, "error").code, "CHAT_TOO_FAST");
    // one player's limit holds nobody else up
    s.handle(host, { type: "chat", text: "c" });
    advance(1);
    s.handle(guest, { type: "chat", text: "d" });
    assert.deepEqual(said(host), ["a", "c", "d"]);
});

test("whoever joins or comes back gets the last CHAT_HISTORY lines with the welcome", () => {
    const { s, host, guest, last, advance } = withGuest();
    for (let i = 0; i < CHAT_HISTORY + 5; i++) {
        s.handle(host, { type: "chat", text: `line ${i}` });
        advance(CHAT_GAP_MS);
    }
    const late = {};
    s.join(late, { name: "Ana" });
    const history = last(late, "welcome").chat;
    assert.equal(history.length, CHAT_HISTORY);
    assert.deepEqual(history[0], { id: last(host, "welcome").playerId, name: "Hans", text: "line 5" });
    assert.equal(history.at(-1).text, `line ${CHAT_HISTORY + 4}`);
    const token = last(guest, "welcome").token;
    s.disconnect(guest);
    const phone = {};
    s.join(phone, { token });
    // Ana's arrival came after her welcome: it is the history's newest line now
    assert.deepEqual(last(phone, "welcome").chat, [...history.slice(1), { system: "joined", name: "Ana" }]);
});

test("coming into, leaving and being kicked from the lobby is a notice in the chat; a reload or a comeback under the same name are not", () => {
    const { s, host, guest, all, last } = withGuest();
    const tv = {};
    s.watch(tv);
    const ida = {};
    s.join(ida, { name: "Ida" });
    assert.deepEqual(last(host, "chat"), { type: "chat", system: "joined", name: "Ida" });
    s.handle(guest, { type: "leave" });
    assert.deepEqual(last(ida, "chat"), { type: "chat", system: "left", name: "Max" });
    // a reload, and a comeback under the same name from another device
    const { token } = last(ida, "welcome");
    s.disconnect(ida);
    const phone = {};
    s.join(phone, { token });
    s.disconnect(phone);
    const laptop = {};
    s.join(laptop, { name: "ida" });
    s.handle(host, { type: "kick", playerId: last(laptop, "welcome").playerId });
    assert.deepEqual(all(host, "chat").map(m => `${m.system} ${m.name}`), ["joined Max", "joined Ida", "left Max", "kicked ida"]);
    assert.equal(all(tv, "chat").length, 0);
});

test("a flood of chat lines is turned away before its text is even looked at", () => {
    const { s, guest, last } = withGuest();
    s.handle(guest, { type: "chat", text: "a" });
    // nothing usable in it, but too fast comes first: cleaning a full frame is the expensive part
    s.handle(guest, { type: "chat", text: "\u200b" });
    assert.equal(last(guest, "error").code, "CHAT_TOO_FAST");
});

test("a name without a letter or a digit is turned away as NAME_INVALID, on create and on join", () => {
    const sent = [];
    const fresh = new Session("WXYZ", { send: (conn, msg) => sent.push({ conn, msg }) });
    assert.equal(fresh.create({}, { name: "🐺🐺", settings: CLASSIC }), false);
    assert.equal(sent.at(-1).msg.code, "NAME_INVALID");
    // bad settings stay INVALID
    assert.equal(fresh.create({}, { name: "Hans", settings: { ...CLASSIC, rounds: 7 } }), false);
    assert.equal(sent.at(-1).msg.code, "INVALID");
    const { s, last } = setup();
    const guest = {};
    assert.equal(s.join(guest, { name: "---" }), false);
    assert.equal(last(guest, "error").code, "NAME_INVALID");
});

test("a look-alike of a player's name is that name: Hans with an invisible mark is NAME_TAKEN", () => {
    const { s, last } = setup();
    const fake = {};
    assert.equal(s.join(fake, { name: "Hans\u034f" }), false);
    assert.equal(last(fake, "error").code, "NAME_TAKEN");
});

// ===== PLAY AGAIN: the next game gets a new code, the old one shows the results =====

test("play again gives the next game a new code: who is still there is welcomed with it and keeps their token", () => {
    const { s, host, guest, last } = started();
    const tv = {};
    s.watch(tv);
    const token = last(guest, "welcome").token;
    toLastReveal(s, host);
    // the first one done with the results takes everyone along; who follows later changes the code no more
    s.handle(guest, { type: "lobby" });
    assert.equal(s.code, "NEW1");
    s.handle(host, { type: "lobby" });
    assert.equal(s.code, "NEW1");
    assert.equal(last(guest, "welcome").code, "NEW1");
    assert.equal(last(guest, "welcome").token, token);
    assert.equal(last(host, "welcome").isHost, true);
    assert.equal(last(guest, "state").code, "NEW1");
    assert.equal(last(tv, "state").code, "NEW1");
});

test("a stranger with the old code gets the results of that game instead of a place in the next one", () => {
    const { s, host, guest, last } = started();
    s.handle(guest, { type: "answer", index: 0, lat: GUESSES[0].lat, lng: GUESSES[0].lng });
    toLastReveal(s, host);
    s.handle(host, { type: "next" });
    s.handle(host, { type: "lobby" });
    const eve = {};
    assert.equal(s.join(eve, { name: "Eve" }, "ABCD"), false);
    const ended = last(eve, "ended");
    assert.deepEqual(ended.ranking.map(r => [r.name, r.score]), [["Max", 100], ["Hans", 0]]);
    assert.deepEqual(ended.winners, [last(guest, "welcome").playerId]);
    assert.equal(s.players.size, 2);
});

test("a player of the old game who was away during play again gets into the next lobby with the old code, not once it runs", () => {
    const { s, host, guest, last, begin } = withGuest();
    const ann = {};
    s.join(ann, { name: "Ann" });
    begin();
    const maxToken = last(guest, "welcome").token;
    const annToken = last(ann, "welcome").token;
    toLastReveal(s, host);
    s.disconnect(guest);
    s.disconnect(ann);
    s.handle(host, { type: "lobby" });
    // their invite link asks with the token, and learns what joining brings
    const look = {};
    s.peek(look, "ABCD", maxToken);
    assert.ok(last(look, "joinable"));
    // back while the next game is still in its lobby: in, under the new code
    const phone = {};
    assert.equal(s.join(phone, { name: "Max", token: maxToken }, "ABCD"), true);
    assert.equal(last(phone, "welcome").code, "NEW1");
    // back once it runs: too late, the old game's results
    begin();
    const glance = {};
    s.peek(glance, "ABCD", annToken);
    assert.ok(last(glance, "ended"));
    const tablet = {};
    assert.equal(s.join(tablet, { name: "Ann", token: annToken }, "ABCD"), false);
    assert.equal(last(tablet, "ended").ranking.length, 3);
});

test("with keepCode play again keeps the code: it leads everyone into the next lobby instead of to the results", () => {
    const { s, host, guest, last } = started({ ...CLASSIC, keepCode: true });
    toLastReveal(s, host);
    s.handle(guest, { type: "lobby" });
    assert.equal(s.code, "ABCD");
    assert.equal(s.past.size, 0);
    assert.equal(last(guest, "welcome").code, "ABCD");
    const eve = {};
    assert.equal(s.join(eve, { name: "Eve" }, "ABCD"), true);
});

test("a session keeps the results of its last MAX_PAST games: the oldest finished game's link stops working first", () => {
    const { s, host, begin } = withGuest();
    for (let i = 0; i <= MAX_PAST; i++) {
        begin();
        toLastReveal(s, host);
        s.handle(host, { type: "lobby" });
    }
    assert.deepEqual([...s.past.keys()], Array.from({ length: MAX_PAST }, (_, i) => `NEW${i + 1}`));
});

test("joining a finished game shows newcomers its results, while its own players still get back in", () => {
    const { s, host, guest, last } = started();
    const token = last(guest, "welcome").token;
    toLastReveal(s, host);
    const eve = {};
    assert.equal(s.join(eve, { name: "Eve" }), false);
    assert.equal(last(eve, "ended").ranking.length, 2);
    s.handle(host, { type: "next" });
    const ann = {};
    assert.equal(s.join(ann, { name: "Ann" }), false);
    assert.equal(last(ann, "ended").ranking.length, 2);
    const phone = {};
    assert.equal(s.join(phone, { name: "Max", token }), true);
    assert.ok(last(phone, "final"));
});

test("peek tells an invite link what is behind a code without taking a place: open lobby, running game or over", () => {
    const { s, host, sent, advance } = withGuest();
    const peek = (code) => {
        const conn = {};
        s.peek(conn, code);
        const reply = sent.find(x => x.conn === conn).msg;
        return reply.type === "error" ? reply.code : reply.type;
    };
    assert.equal(peek("ABCD"), "joinable");
    s.handle(host, { type: "start", guesses: GUESSES });
    // the host can still call the start off: the form stays
    assert.equal(peek("ABCD"), "joinable");
    readyAll(s, 0);
    advance(COUNTDOWN_FORCED_MS);
    s.tick();
    assert.equal(peek("ABCD"), "GAME_RUNNING");
    toLastReveal(s, host);
    assert.equal(peek("ABCD"), "ended");
    s.handle(host, { type: "lobby" });
    assert.equal(peek("ABCD"), "ended");
    assert.equal(peek("NEW1"), "joinable");
    assert.equal(s.players.size, 2);
    assert.equal(s.watchers.size, 0);
});

test("check tells a token that can come back where the game is, and changes nothing", () => {
    const { s, sent, host, guest, last, advance } = withGuest();
    s.join({}, { name: "Ida" });
    const { playerId, token } = last(guest, "welcome");
    s.disconnect(guest);
    // only the probe hears back: no broadcast, and the player stays offline
    const check = () => {
        const conn = {};
        const before = sent.length;
        s.check(conn, token);
        assert.equal(sent.length, before + 1);
        assert.equal(s.players.get(playerId).connected, false);
        return sent.at(-1).msg;
    };
    assert.deepEqual(check(), { type: "resumable", code: "ABCD", phase: "lobby", round: 0, total: 3 });
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.deepEqual(check(), { type: "resumable", code: "ABCD", phase: "loading", round: 0, total: 3 });
    readyAll(s, 0);
    advance(COUNTDOWN_FORCED_MS);
    s.tick();
    assert.deepEqual(check(), { type: "resumable", code: "ABCD", phase: "round", round: 0, total: 3 });
    s.handle(host, { type: "endRound" });
    assert.deepEqual(check(), { type: "resumable", code: "ABCD", phase: "reveal", round: 0, total: 3 });
});

test("check turns away an unknown or odd token, a kicked player, who left the lobby, and a game that is over", () => {
    const { s, host, guest, last, begin } = withGuest();
    const answer = (token) => {
        const conn = {};
        s.check(conn, token);
        return last(conn, "resumable") ? "resumable" : last(conn, "error").code;
    };
    assert.equal(answer("nope"), "SESSION_NOT_FOUND");
    assert.equal(answer(undefined), "SESSION_NOT_FOUND");
    assert.equal(answer({ toString: 1 }), "SESSION_NOT_FOUND");
    const ida = {};
    s.join(ida, { name: "Ida" });
    s.handle(host, { type: "kick", playerId: last(ida, "welcome").playerId });
    assert.equal(answer(last(ida, "welcome").token), "SESSION_NOT_FOUND");
    const ana = {};
    s.join(ana, { name: "Ana" });
    s.handle(ana, { type: "leave" });
    assert.equal(answer(last(ana, "welcome").token), "SESSION_NOT_FOUND");
    // the last round is still worth coming back for, its reveal and the final are not
    const token = last(guest, "welcome").token;
    begin();
    for (let i = 0; i < 2; i++) {
        s.handle(host, { type: "endRound" });
        readyAll(s, s.round + 1);
        s.handle(host, { type: "next" });
    }
    assert.equal(answer(token), "resumable");
    s.handle(host, { type: "endRound" });
    assert.equal(s.phase, "reveal");
    assert.equal(answer(token), "SESSION_NOT_FOUND");
    s.handle(host, { type: "next" });
    assert.equal(s.phase, "final");
    assert.equal(answer(token), "SESSION_NOT_FOUND");
});

test("who left during the countdown comes back with their token, even once round 1 runs", () => {
    const { s, host, guest, last, advance } = withGuest();
    const { playerId, token } = last(guest, "welcome");
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(guest, { type: "leave" });
    readyAll(s, 0);
    advance(COUNTDOWN_FORCED_MS);
    s.tick();
    assert.equal(s.phase, "round");
    const phone = {};
    assert.equal(s.join(phone, { token }), true);
    assert.equal(last(phone, "welcome").playerId, playerId);
    assert.equal(last(phone, "round").index, 0);
});

test("leaving the lobby tells everyone else who left; a kick, a dropped connection and leaving later do not", () => {
    const { s, host, guest, all, last, advance } = withGuest();
    const tv = {};
    s.watch(tv);
    const join = (name) => {
        const conn = {};
        s.join(conn, { name });
        return conn;
    };
    const ida = join("Ida");
    s.handle(ida, { type: "leave" });
    const left = [{ type: "left", name: "Ida" }];
    assert.deepEqual([all(host, "left"), all(guest, "left"), all(tv, "left"), all(ida, "left")], [left, left, left, []]);
    const eve = join("Eve");
    s.handle(host, { type: "kick", playerId: last(eve, "welcome").playerId });
    s.disconnect(join("Ana"));
    const bob = join("Bob");
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(guest, { type: "leave" });
    readyAll(s, 0);
    advance(COUNTDOWN_FORCED_MS);
    s.tick();
    assert.equal(s.phase, "round");
    s.handle(bob, { type: "leave" });
    assert.deepEqual(all(host, "left"), left);
});

test("the reconnect window is 30 s: long enough for a quick app switch or a trip to another page and back", () => {
    const { s, host, guest, advance } = started();
    s.disconnect(guest);
    s.handle(host, { type: "answer", index: s.round, lat: -100, lng: 200 });
    advance(29 * 1000);
    s.tick();
    assert.equal(s.phase, "round");
    advance(1000);
    s.tick();
    assert.equal(s.phase, "reveal");
});

test("someone new who joins the countdown after everyone left still gets the time to load round 1", () => {
    const { s, host, guest, advance } = withGuest();
    s.handle(host, { type: "start", guesses: GUESSES });
    s.disconnect(host);
    s.disconnect(guest);
    advance(COUNTDOWN_FORCED_MS + LOAD_FIRST_MS);
    s.tick();
    assert.equal(s.phase, "loading");
    const late = {};
    assert.equal(s.join(late, { name: "Late" }), true);
    s.tick();
    assert.equal(s.phase, "loading");
    s.handle(late, { type: "ready", index: 0 });
    assert.equal(s.phase, "round");
});
