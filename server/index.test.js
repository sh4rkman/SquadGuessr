import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import WebSocket from "ws";
import { startServer } from "./index.js";

/**
 * Server on a random port; the server and every client are closed after the test even when an assertion fails
 */
async function serve(t, options = {}) {
    const wss = startServer({ port: 0, ...options });
    const clients = [];
    t.after(() => {
        clients.forEach(c => c.terminate());
        wss.close();
    });
    await once(wss, "listening");
    const port = wss.address().port;
    const client = async function () {
        const ws = new WebSocket(`ws://localhost:${port}/mp`);
        clients.push(ws);
        const inbox = [];
        const waiters = [];
        ws.on("message", (data) => {
            const msg = JSON.parse(data);
            const i = waiters.findIndex(w => w.type === msg.type);
            if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
            else inbox.push(msg);
        });
        ws.next = (type) => {
            const i = inbox.findIndex(m => m.type === type);
            if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
            return new Promise(resolve => waiters.push({ type, resolve }));
        };
        ws.sendJson = (msg) => ws.send(JSON.stringify(msg));
        await once(ws, "open");
        return ws;
    };
    client.wss = wss;
    return client;
}

const tick = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const CREATE = { type: "create", name: "Hans", settings: { mode: "classic", timer: 0, rounds: 3 } };

test("create, join by lowercase code, reject garbage", { timeout: 5000 }, async (t) => {
    const client = await serve(t);

    const host = await client();
    host.sendJson(CREATE);
    const welcome = await host.next("welcome");
    assert.match(welcome.code, /^[A-HJ-NP-Z2-9]{4}$/);
    assert.equal(typeof welcome.serverNow, "number");

    const guest = await client();
    guest.sendJson({ type: "join", code: welcome.code.toLowerCase(), name: "Max" });
    await guest.next("welcome");
    const state = await guest.next("state");
    assert.deepEqual(state.players.map(p => p.name), ["Hans", "Max"]);

    guest.send("not json");
    assert.equal((await guest.next("error")).code, "INVALID");

    const stranger = await client();
    stranger.sendJson({ type: "join", code: "ZZZZ", name: "Eve" });
    assert.equal((await stranger.next("error")).code, "SESSION_NOT_FOUND");

    stranger.sendJson({ type: "next" });
    assert.equal((await stranger.next("error")).code, "INVALID");

    // drain the host's older states up to the one that lists Max
    while (!(await host.next("state")).players.some(p => p.name === "Max"));
    guest.close();
    const afterClose = await host.next("state");
    assert.deepEqual(afterClose.players.map(p => [p.name, p.connected]), [["Hans", true], ["Max", false]], "a guest whose connection closed stays, offline");
});

test("an oversized frame does not crash the server", { timeout: 5000 }, async (t) => {
    const client = await serve(t);

    const attacker = await client();
    attacker.send("x".repeat(70000));
    await once(attacker, "close");

    const host = await client();
    host.sendJson(CREATE);
    assert.equal((await host.next("welcome")).code.length, 4);
});

test("session creation is capped", { timeout: 5000 }, async (t) => {
    const client = await serve(t, { maxSessions: 2 });
    for (let i = 0; i < 2; i++) {
        const host = await client();
        host.sendJson(CREATE);
        await host.next("welcome");
    }
    const late = await client();
    late.sendJson(CREATE);
    assert.equal((await late.next("error")).code, "SERVER_BUSY");
});

test("a code that is not a string does not crash the server", { timeout: 5000 }, async (t) => {
    const client = await serve(t);
    const attacker = await client();
    attacker.sendJson({ type: "join", code: { toString: 1 }, name: "Eve" });
    assert.equal((await attacker.next("error")).code, "SESSION_NOT_FOUND");

    const host = await client();
    host.sendJson(CREATE);
    assert.equal((await host.next("welcome")).code.length, 4);
});

test("a socket gets one create/join/watch, so it can neither pile up sessions nor probe codes", { timeout: 5000 }, async (t) => {
    const client = await serve(t, { maxSessions: 2 });
    const host = await client();
    host.sendJson(CREATE);
    const { code } = await host.next("welcome");
    host.sendJson(CREATE);
    assert.equal((await host.next("error")).code, "INVALID");

    const prober = await client();
    prober.sendJson({ type: "watch", code: "ZZZZ" });
    assert.equal((await prober.next("error")).code, "SESSION_NOT_FOUND");
    prober.sendJson({ type: "watch", code });
    assert.equal((await prober.next("error")).code, "INVALID");

    const other = await client();
    other.sendJson(CREATE);
    assert.equal((await other.next("welcome")).code.length, 4);
});

test("sessions nobody is connected to make room when the server is full", { timeout: 5000 }, async (t) => {
    const client = await serve(t, { maxSessions: 2 });
    for (let i = 0; i < 2; i++) {
        const gone = await client();
        gone.sendJson(CREATE);
        await gone.next("welcome");
        gone.close();
        await once(gone, "close");
    }
    await tick(20);
    const host = await client();
    host.sendJson(CREATE);
    assert.equal((await host.next("welcome")).code.length, 4);
});

test("a client that stops reading is dropped instead of buffering replies forever", { timeout: 10000 }, async (t) => {
    const client = await serve(t);
    const attacker = await client();
    attacker._socket.pause();
    for (let i = 0; i < 300000; i++) attacker.send("x");
    while (client.wss.clients.size > 0) await tick(50);
});

/**
 * Host and guest play a 3-round chill game to its last reveal and the host presses PLAY AGAIN: the new code
 */
async function playAgain(host, guest) {
    guest.sendJson({ type: "lobbyReady", ready: true });
    const guesses = ["Narva", "GooseBay", "Kohat"].map((map, i) => ({ map, url: `/img/guesses/${i}.webp`, lat: -100, lng: 100 }));
    host.sendJson({ type: "start", guesses });
    for (let i = 0; i < 3; i++) {
        await host.next("round");
        host.sendJson({ type: "endRound" });
        await host.next("reveal");
        if (i < 2) host.sendJson({ type: "next" });
    }
    host.sendJson({ type: "lobby" });
    return (await host.next("welcome")).code;
}

test("after play again the old code shows its results, the new one leads into the lobby, watching follows the session", { timeout: 30000 }, async (t) => {
    const client = await serve(t, { idleMs: 100 });
    // what a fresh socket hears first about a code: its results or an error
    const ask = async (msg) => {
        const ws = await client();
        ws.sendJson(msg);
        return Promise.race([ws.next("ended"), ws.next("error")]);
    };
    const host = await client();
    host.sendJson(CREATE);
    const { code } = await host.next("welcome");
    const guest = await client();
    guest.sendJson({ type: "join", code, name: "Max" });
    await guest.next("welcome");
    const tv = await client();
    tv.sendJson({ type: "watch", code });
    await tv.next("state");
    // both report every announced round's images at once
    [host, guest].forEach(ws => ws.on("message", (data) => {
        const msg = JSON.parse(data);
        if (msg.type === "prepare") ws.sendJson({ type: "ready", index: msg.index });
    }));
    const next = await playAgain(host, guest);
    assert.notEqual(next, code);
    while ((await tv.next("state")).code !== next);

    const stranger = await client();
    stranger.sendJson({ type: "join", code: code.toLowerCase(), name: "Eve" });
    assert.deepEqual((await stranger.next("ended")).ranking.map(r => r.name).sort(), ["Hans", "Max"]);

    const looker = await client();
    looker.sendJson({ type: "peek", code });
    await looker.next("ended");
    looker.sendJson({ type: "join", code: next, name: "Eve" });
    assert.equal((await looker.next("error")).code, "INVALID", "a peek is the socket's one try");

    const late = await client();
    late.sendJson({ type: "join", code: next, name: "Eve" });
    await late.next("welcome");
    late.close();

    // a big screen reloading its old link (an OBS source does) keeps following the session
    const reloadedTv = await client();
    reloadedTv.sendJson({ type: "watch", code });
    assert.equal((await reloadedTv.next("state")).code, next);

    // once the session is dropped for idling, its old codes go with it
    [host, guest, tv, reloadedTv].forEach(ws => ws.close());
    while ((await ask({ type: "peek", code })).type !== "error") await tick(100);
});

test("check answers on its own socket, counts as its one greeting and makes it nobody in the session", { timeout: 5000 }, async (t) => {
    const client = await serve(t);
    const host = await client();
    host.sendJson(CREATE);
    const { code, token } = await host.next("welcome");

    const probe = await client();
    probe.sendJson({ type: "check", code: code.toLowerCase(), token });
    const answer = await probe.next("resumable");
    assert.deepEqual([answer.code, answer.phase, answer.round, answer.total], [code, "lobby", 0, 3]);
    probe.sendJson({ type: "join", code, name: "Eve" });
    assert.equal((await probe.next("error")).code, "INVALID");
    probe.sendJson({ type: "lobbyReady", ready: true });
    assert.equal((await probe.next("error")).code, "INVALID");

    const stranger = await client();
    stranger.sendJson({ type: "check", code: "ZZZZ", token });
    assert.equal((await stranger.next("error")).code, "SESSION_NOT_FOUND");
});
