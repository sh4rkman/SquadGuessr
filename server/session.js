import { randomUUID } from "node:crypto";
import { scoreAnswer, mapSize } from "../src/js/scoring.js";
import { cleanName, validSettings, validGuesses, validAnswer } from "./validate.js";

export const MAX_PLAYERS = 12;
export const MAX_WATCHERS = 20;
export const GRACE_MS = 1000;
export const RECONNECT_MS = 15 * 1000;
// how long a round waits for slow devices to load its images: the first one cold, later ones were preloaded
export const LOAD_FIRST_MS = 10 * 1000;
export const LOAD_MS = 5 * 1000;

const HOST_ACTIONS = ["settings", "start", "endRound", "next", "lobby", "kick"];

/**
 * One multiplayer session: lobby → loading → round → reveal → loading → … → final
 * Knows nothing about sockets: `send(conn, msg)` is injected and `conn` is opaque.
 * On every phase change `state` is sent before `prepare`/`round`/`reveal`/`final`.
 */
export class Session {
    constructor(code, { send, now = Date.now }) {
        this.code = code;
        this.send = send;
        this.now = now;
        this.hostId = null;
        this.settings = null;
        this.guesses = [];
        this.phase = "lobby";
        this.round = 0;
        this.deadline = null;
        this.loadUntil = null;
        this.players = new Map();
        this.watchers = new Set();
        this.kicked = new Set();
        this.lastActivity = now();
    }

    // ===== ENTRY =====

    create(conn, { name, settings }) {
        const clean = cleanName(name);
        if (!clean || !validSettings(settings)) return this.error(conn, "INVALID");
        this.settings = pickSettings(settings);
        const player = this.addPlayer(conn, clean);
        this.hostId = player.id;
        this.welcome(player);
        this.broadcastState();
        return true;
    }

    join(conn, { name, token }) {
        if (token && this.kicked.has(token)) return this.error(conn, "KICKED");
        const known = token ? this.findPlayer(p => p.token === token) : null;
        if (known) return this.reconnect(known, conn);
        if (this.phase !== "lobby") return this.error(conn, "GAME_RUNNING");
        const clean = cleanName(name);
        if (!clean) return this.error(conn, "INVALID");
        const same = this.findPlayer(p => p.name.toLowerCase() === clean.toLowerCase());
        if (same?.connected) return this.error(conn, "NAME_TAKEN");
        // someone who dropped out of the lobby may come back without their token (other device, other tab): same name, their place
        if (same) this.players.delete(same.id);
        if (this.players.size >= MAX_PLAYERS) return this.error(conn, "SESSION_FULL");
        const player = this.addPlayer(conn, clean);
        if (same?.id === this.hostId) this.hostId = player.id;
        this.welcome(player);
        this.broadcastState();
        return true;
    }

    watch(conn) {
        if (this.watchers.size >= MAX_WATCHERS) return this.error(conn, "SESSION_FULL");
        this.watchers.add(conn);
        this.send(conn, this.stateMsg());
        this.sendPhase(conn);
        return true;
    }

    disconnect(conn) {
        this.touch();
        this.watchers.delete(conn);
        const player = this.playerByConn(conn);
        if (!player) return;
        // a dropped connection is mostly a reload, a locked phone or a network switch: the player keeps their place
        // (and for a moment still counts for the round and the host role) so they can come back with their token
        player.conn = null;
        player.connected = false;
        player.awayUntil = this.now() + RECONNECT_MS;
        this.broadcastState();
    }

    // ===== ACTIONS =====

    handle(conn, msg) {
        const player = this.playerByConn(conn);
        if (!player) return this.error(conn, "INVALID");
        this.touch();
        if (msg.type === "answer") return this.answer(player, msg);
        if (msg.type === "ready") return this.ready(player, msg.index);
        if (msg.type === "leave") return this.leave(player);
        if (!HOST_ACTIONS.includes(msg.type)) return this.error(conn, "INVALID");
        if (player.id !== this.hostId) return this.error(conn, "NOT_HOST");

        switch (msg.type) {
        case "settings": return this.updateSettings(conn, msg.settings);
        case "start": return this.start(conn, msg.guesses);
        case "endRound": return this.phase === "round" && this.deadline === null ? this.endRound() : this.error(conn, "INVALID");
        case "next": return this.next(conn);
        case "lobby": return this.toLobby(conn);
        case "kick": return this.kick(conn, msg.playerId);
        }
    }

    /**
     * Lobby only, and no ban: whoever is kicked can come back through the invite link, just not with their old token
     */
    kick(conn, playerId) {
        if (this.phase !== "lobby" || playerId === this.hostId) return this.error(conn, "INVALID");
        const player = this.players.get(playerId);
        // already gone (double click, left at the same moment): nothing to do
        if (!player) return;
        // someone offline right now never gets the message: their reconnect with the old token is turned away instead
        this.kicked.add(player.token);
        this.error(player.conn, "KICKED");
        this.leave(player);
    }

    updateSettings(conn, settings) {
        if (this.phase !== "lobby" || !validSettings(settings)) return this.error(conn, "INVALID");
        this.settings = pickSettings(settings);
        this.broadcastState();
    }

    start(conn, guesses) {
        if (!["lobby", "final"].includes(this.phase) || !validGuesses(guesses, this.settings.rounds)) {
            return this.error(conn, "INVALID");
        }
        this.guesses = guesses.map(g => ({ map: g.map, url: g.url, lat: g.lat, lng: g.lng, submitter: g.submitter ?? null }));
        this.resetScores();
        this.round = 0;
        this.load();
    }

    /**
     * Holds the round back until every connected player has its images (or the time is up), so all see it at once
     */
    load() {
        this.phase = "loading";
        this.loadUntil = this.now() + (this.round === 0 ? LOAD_FIRST_MS : LOAD_MS);
        // the usual case from the second round on: everyone preloaded it during the previous round
        if (this.lateLoaders().length === 0) return this.startRound();
        this.broadcastState();
        this.broadcast(this.prepareMsg(this.round));
    }

    /**
     * Who the loading round waits for: watchers never count, nor does a player whose connection is gone
     */
    lateLoaders() {
        return [...this.players.values()].filter(p => p.connected && !p.stalled && p.ready < this.round);
    }

    checkLoaded() {
        // with nobody connected the clock must not start: whoever comes back is waited for until loadUntil
        if (!this.findPlayer(p => p.connected)) return;
        const late = this.lateLoaders();
        if (late.length > 0 && this.now() < this.loadUntil) return;
        // a phone locked with its socket still open would hold up every round: not waited for until it reports back
        late.forEach(p => { p.stalled = true; });
        this.startRound();
    }

    /**
     * A client has the images of round `index`. Never answered with an error: duplicates and late ones are normal
     */
    ready(player, index) {
        if (!["loading", "round", "reveal"].includes(this.phase) || !Number.isInteger(index)) return;
        // while loading only the waited-for round, otherwise the running one or the announced next one: a ready
        // left over from an earlier game falls outside and cannot mark a whole new game as loaded
        const newest = this.phase === "loading" ? this.round : this.round + 1;
        if (index < this.round || index > newest || index >= this.guesses.length) return;
        const changed = player.stalled || player.ready < index;
        player.ready = Math.max(player.ready, index);
        player.stalled = false;
        if (this.phase !== "loading" || !changed) return;
        this.checkLoaded();
        if (this.phase === "loading") this.broadcastState();
    }

    startRound() {
        this.phase = "round";
        this.deadline = this.settings.timer > 0 ? this.now() + this.settings.timer * 1000 : null;
        this.broadcastState();
        this.broadcast(this.roundMsg());
        // the next round's images load while this one is played
        if (this.round + 1 < this.guesses.length) this.broadcast(this.prepareMsg(this.round + 1));
    }

    answer(player, msg) {
        // the index pins a late answer to its own round instead of the one currently running
        if (this.phase !== "round" || msg.index !== this.round || player.answers[this.round] || !validAnswer(msg, this.settings.mode)) {
            return this.error(player.conn, "INVALID");
        }
        const size = mapSize(this.guesses[this.round].map);
        // kept on the map like the client's marker: absurd coordinates would break the reveal on every screen
        const answer = this.settings.mode === "classic"
            ? { lat: clamp(msg.lat, -size, 0), lng: clamp(msg.lng, 0, size), mapName: null }
            : { lat: null, lng: null, mapName: msg.mapName };
        player.answers[this.round] = { ...answer, ...scoreAnswer(this.settings.mode, this.guesses[this.round], answer) };
        this.broadcastState();
        this.checkRoundEnd();
    }

    /**
     * Explicit "leave": frees name and slot in the lobby; during a game the player stays in the ranking, offline.
     * Unlike a dropped connection it takes effect at once: a leaving host hands the role over right away.
     */
    leave(player) {
        if (this.phase === "lobby") {
            this.players.delete(player.id);
        } else {
            player.conn = null;
            player.connected = false;
            player.awayUntil = 0;
        }
        this.fixHost();
        this.broadcastState();
        this.checkRoundEnd();
    }

    checkRoundEnd() {
        if (this.phase === "loading") return this.checkLoaded();
        if (this.phase !== "round") return;
        const waiting = [...this.players.values()].some(p => this.isPresent(p) && !p.answers[this.round]);
        if (!waiting) this.endRound();
    }

    endRound() {
        this.phase = "reveal";
        this.deadline = null;
        this.players.forEach(p => {
            if (!p.answers[this.round]) p.answers[this.round] = { lat: null, lng: null, mapName: null, distance: null, points: 0 };
            p.score += p.answers[this.round].points;
        });
        this.broadcastState();
        this.broadcast(this.revealMsg());
    }

    next(conn) {
        if (this.phase !== "reveal") return this.error(conn, "INVALID");
        if (this.round + 1 < this.guesses.length) {
            this.round++;
            return this.load();
        }
        this.phase = "final";
        this.broadcastState();
        this.broadcast(this.finalMsg());
    }

    toLobby(conn) {
        // the last reveal counts as over: players see their results without waiting for the host's "next",
        // and one of them may have become host there
        const lastReveal = this.phase === "reveal" && this.round + 1 === this.guesses.length;
        if (this.phase !== "final" && !lastReveal) return this.error(conn, "INVALID");
        this.phase = "lobby";
        this.guesses = [];
        this.round = 0;
        // whoever left or dropped out during the game does not haunt the next one (coming back simply joins again)
        this.players.forEach(p => { if (!p.connected) this.players.delete(p.id); });
        this.resetScores();
        this.broadcastState();
    }

    tick() {
        if (this.fixHost()) this.broadcastState();
        if (this.phase === "round" && this.deadline !== null && this.now() >= this.deadline + GRACE_MS) return this.endRound();
        // someone who dropped out and did not come back in time stops holding up the round
        this.checkRoundEnd();
    }

    /**
     * Once the host left, or has been gone for longer than a reload takes, a connected player takes over;
     * with nobody connected the role waits for whoever comes (back) first. True if the host changed.
     */
    fixHost() {
        const host = this.players.get(this.hostId);
        if (host && this.isPresent(host)) return false;
        const next = this.findPlayer(p => p.connected);
        if (!next) return false;
        this.hostId = next.id;
        return true;
    }

    /**
     * Only a session nobody is connected to can go idle
     */
    isIdle(ms) {
        if (this.watchers.size > 0 || this.findPlayer(p => p.connected)) return false;
        return this.now() - this.lastActivity > ms;
    }

    // ===== MESSAGES =====

    stateMsg() {
        return {
            type: "state",
            code: this.code,
            phase: this.phase,
            settings: this.settings,
            hostId: this.hostId,
            round: this.round,
            total: this.guesses.length || this.settings.rounds,
            players: [...this.players.values()].map(p => ({
                id: p.id,
                name: p.name,
                connected: p.connected,
                score: p.score,
                answered: this.phase === "round" && Boolean(p.answers[this.round]),
                ready: this.phase === "loading" && p.ready >= this.round,
                stalled: p.stalled,
            })),
        };
    }

    /**
     * What a client needs to show or preload round i: never the solution, and in mapFinder not the map (it is the answer)
     */
    assets(i) {
        const g = this.guesses[i];
        return { index: i, url: g.url, map: this.settings.mode === "classic" ? g.map : null };
    }

    roundMsg() {
        const g = this.guesses[this.round];
        return { type: "round", ...this.assets(this.round), total: this.guesses.length, submitter: g.submitter, deadline: this.deadline };
    }

    prepareMsg(i) {
        return { type: "prepare", ...this.assets(i) };
    }

    revealMsg() {
        const g = this.guesses[this.round];
        const results = [...this.players.values()]
            .map(p => ({ id: p.id, name: p.name, score: p.score, ...p.answers[this.round] }))
            .sort((a, b) => b.score - a.score);
        return {
            type: "reveal",
            index: this.round,
            total: this.guesses.length,
            solution: { map: g.map, url: g.url, lat: g.lat, lng: g.lng },
            results,
        };
    }

    finalMsg() {
        const ranking = [...this.players.values()]
            .map(p => ({ id: p.id, name: p.name, score: p.score }))
            .sort((a, b) => b.score - a.score);
        const top = ranking[0]?.score;
        return { type: "final", ranking, winners: ranking.filter(r => r.score === top).map(r => r.id) };
    }

    // ===== HELPERS =====

    addPlayer(conn, name) {
        const player = { id: randomUUID(), token: randomUUID(), name, conn, connected: true, awayUntil: 0, score: 0, answers: [], ready: -1, stalled: false };
        this.players.set(player.id, player);
        return player;
    }

    reconnect(player, conn) {
        // same token from another tab or device: the old connection is told instead of silently going deaf
        if (player.conn && player.conn !== conn) this.error(player.conn, "REPLACED");
        player.conn = conn;
        player.connected = true;
        // a reload loses the preloaded images: the client reports them again for the prepare that sendPhase resends
        player.ready = Math.min(player.ready, this.round - 1);
        player.stalled = false;
        // everyone was away when loadUntil passed: the first one back gets a fresh wait, not a clock that starts at once
        if (this.phase === "loading" && this.now() >= this.loadUntil) this.loadUntil = this.now() + LOAD_MS;
        this.welcome(player);
        this.broadcastState();
        this.sendPhase(conn);
        return true;
    }

    sendPhase(conn) {
        if (this.phase === "loading") this.send(conn, this.prepareMsg(this.round));
        if (this.phase === "round") this.send(conn, this.roundMsg());
        if (this.phase === "reveal") this.send(conn, this.revealMsg());
        if (this.phase === "final") this.send(conn, this.finalMsg());
        if (["round", "reveal"].includes(this.phase) && this.round + 1 < this.guesses.length) {
            this.send(conn, this.prepareMsg(this.round + 1));
        }
    }

    welcome(player) {
        this.send(player.conn, { type: "welcome", playerId: player.id, token: player.token, code: this.code, isHost: player.id === this.hostId });
    }

    resetScores() {
        this.players.forEach(p => { p.score = 0; p.answers = []; p.ready = -1; p.stalled = false; });
    }

    broadcastState() {
        this.broadcast(this.stateMsg());
    }

    broadcast(msg) {
        this.players.forEach(p => { if (p.conn) this.send(p.conn, msg); });
        this.watchers.forEach(conn => this.send(conn, msg));
    }

    error(conn, code) {
        if (conn) this.send(conn, { type: "error", code });
        return false;
    }

    /**
     * Connected, or dropped a moment ago and probably reconnecting
     */
    isPresent(player) {
        return player.connected || this.now() < player.awayUntil;
    }

    playerByConn(conn) {
        return this.findPlayer(p => p.conn === conn);
    }

    findPlayer(predicate) {
        return [...this.players.values()].find(predicate);
    }

    touch() {
        this.lastActivity = this.now();
    }
}

function pickSettings({ mode, timer, rounds }) {
    return { mode, timer, rounds };
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
