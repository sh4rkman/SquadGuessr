import { test } from "node:test";
import assert from "node:assert/strict";
import { Session, MAX_PLAYERS, RECONNECT_MS, LOAD_FIRST_MS, LOAD_MS } from "./session.js";
import { mapSize } from "../src/js/scoring.js";

const CLASSIC = { mode: "classic", timer: 0, rounds: 3 };
const GUESSES = [
    { map: "Narva", url: "/img/guesses/a.webp", lat: -100, lng: 200, submitter: "Dan" },
    { map: "GooseBay", url: "/img/guesses/b.webp", lat: -300, lng: 400 },
    { map: "Kohat", url: "/img/guesses/c.webp", lat: -500, lng: 600 },
];

function setup(settings = CLASSIC) {
    let t = 1000;
    const sent = [];
    const s = new Session("ABCD", { send: (conn, msg) => sent.push({ conn, msg }), now: () => t });
    const all = (conn, type) => sent.filter(x => x.conn === conn && x.msg.type === type).map(x => x.msg);
    const last = (conn, type) => all(conn, type).at(-1);
    const host = { id: "host" };
    s.create(host, { name: "Hans", settings });
    return { s, sent, host, all, last, advance: (ms) => { t += ms; } };
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
    ctx.s.handle(ctx.host, { type: "start", guesses: GUESSES });
    readyAll(ctx.s, 0);
    return ctx;
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

test("only the host may control the game", () => {
    const { s, guest, last } = withGuest();
    s.handle(guest, { type: "start", guesses: GUESSES });
    assert.equal(last(guest, "error").code, "NOT_HOST");
    assert.equal(s.phase, "lobby");
});

test("host can change settings in the lobby", () => {
    const { s, host, guest, last } = withGuest();
    s.handle(host, { type: "settings", settings: { mode: "mapFinder", timer: 15, rounds: 5 } });
    assert.deepEqual(last(guest, "state").settings, { mode: "mapFinder", timer: 15, rounds: 5 });
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

test("watchers receive state and rounds but cannot act", () => {
    const { s, host, last } = withGuest();
    const tv = {};
    assert.equal(s.watch(tv), true);
    assert.equal(last(tv, "state").phase, "lobby");
    s.handle(host, { type: "start", guesses: GUESSES });
    readyAll(s, 0);
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

test("the host can kick a player from the lobby: they are told, their old token stays out, name and slot are free", () => {
    const { s, host, guest, last } = withGuest();
    const { playerId, token } = last(guest, "welcome");
    s.handle(host, { type: "kick", playerId });
    assert.equal(last(guest, "error").code, "KICKED");
    assert.deepEqual(last(host, "state").players.map(p => p.name), ["Hans"]);
    // offline at the kick, they never got the message: their reconnect must not quietly undo it
    const back = {};
    assert.equal(s.join(back, { name: "Max", token }), false);
    assert.equal(last(back, "error").code, "KICKED");
    assert.equal(s.join({}, { name: "Max" }), true);
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

test("leaving a running game keeps the player's score but marks them offline", () => {
    const { s, host, guest, last } = started();
    s.handle(guest, { type: "leave" });
    const max = last(host, "state").players.find(p => p.name === "Max");
    assert.equal(max.connected, false);
    s.handle(host, { type: "answer", index: 0, lat: -100, lng: 200 });
    assert.equal(s.phase, "reveal");
});

test("a host who leaves hands the host role to the next connected player", () => {
    const { s, host, guest, last } = withGuest();
    s.handle(host, { type: "leave" });
    const state = last(guest, "state");
    assert.equal(state.hostId, last(guest, "welcome").playerId);
    assert.deepEqual(state.players.map(p => p.name), ["Max"]);
    s.handle(guest, { type: "start", guesses: GUESSES });
    readyAll(s, 0);
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
    const { s, host, guest, last } = withGuest();
    const token = last(guest, "welcome").token;
    s.disconnect(guest);
    assert.deepEqual(last(host, "state").players.map(p => [p.name, p.connected]), [["Hans", true], ["Max", false]]);
    s.handle(host, { type: "start", guesses: GUESSES });
    readyAll(s, 0);
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
    const { s, host, last } = setup();
    const tv = {};
    s.watch(tv);
    s.handle(host, { type: "leave" });
    const phone = {};
    s.join(phone, { name: "Hans" });
    s.tick();
    assert.equal(last(tv, "state").hostId, last(phone, "welcome").playerId);
    s.handle(phone, { type: "start", guesses: GUESSES });
    readyAll(s, 0);
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
    s.handle(host, { type: "start", guesses: GUESSES });
    assert.equal(last(guest, "state").phase, "loading");
    assert.deepEqual(last(guest, "prepare"), { type: "prepare", index: 0, url: "/img/guesses/a.webp", map: "Narva" });
    assert.equal(last(guest, "round"), undefined);
    s.handle(host, { type: "answer", index: 0, lat: -100, lng: 200 });
    assert.equal(last(host, "error").code, "INVALID");
    advance(3000);
    s.handle(host, { type: "ready", index: 0 });
    assert.deepEqual(last(guest, "state").players.map(p => [p.name, p.ready, p.stalled]), [["Hans", true, false], ["Max", false, false]]);
    s.handle(guest, { type: "ready", index: 0 });
    assert.equal(s.phase, "round");
    assert.equal(last(guest, "round").deadline, 1000 + 3000 + 15000);
});

test("loading waits at most LOAD_FIRST_MS, then LOAD_MS; who missed it is not waited for until they report back", () => {
    const { s, host, guest, last, advance } = withGuest();
    const max = () => s.findPlayer(p => p.name === "Max");
    const skip = (i) => { s.handle(host, { type: "endRound" }); s.handle(host, { type: "ready", index: i }); s.handle(host, { type: "next" }); };
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
    const { s, host, guest } = withGuest();
    const ida = {};
    s.join(ida, { name: "Ida" });
    s.handle(host, { type: "start", guesses: GUESSES });
    s.handle(host, { type: "ready", index: 0 });
    s.disconnect(guest);
    s.tick();
    assert.equal(s.phase, "loading");
    s.handle(ida, { type: "leave" });
    assert.equal(s.phase, "round");
});

test("with everyone away, loading waits; the first one back gets a fresh wait that still ends after LOAD_MS", () => {
    const { s, host, guest, last, advance } = withGuest();
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
    const { s, host, last } = withGuest();
    s.handle(host, { type: "start", guesses: GUESSES });
    const tv = {};
    s.watch(tv);
    assert.deepEqual([last(tv, "state").phase, last(tv, "prepare").index], ["loading", 0]);
    readyAll(s, 0);
    assert.equal(s.phase, "round");
    assert.equal(last(tv, "prepare").index, 1);
});

test("mapFinder never sends the map ahead, not even for preloading", () => {
    const { guest, all } = started({ mode: "mapFinder", timer: 0, rounds: 3 });
    assert.deepEqual(all(guest, "prepare").map(m => m.map), [null, null]);
});
