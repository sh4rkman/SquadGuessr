import { WebSocketServer } from "ws";
import { randomInt } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Session } from "./session.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const IDLE_MS = 30 * 60 * 1000;
const TICK_MS = 500;
const HEARTBEAT_MS = 30 * 1000;
const MAX_SESSIONS = 1000;
// far above any burst a real client needs; a client that stops reading must not make us queue replies forever
const MAX_BUFFERED = 64 * 1024;
// a real client sends a few messages a second at most, each one a click or an event (ready, answer, a chat line):
// a connection may send MSG_BURST at once and MSG_PER_S more every second. Whoever goes beyond is cut off before one
// more of their messages is read; a real client recovers from that best, it reconnects and gets the whole state again
export const MSG_BURST = 20;
export const MSG_PER_S = 5;

/**
 * Multiplayer session server: routes socket messages to Session instances
 */
export function startServer({ port = 3001, idleMs = IDLE_MS, maxSessions = MAX_SESSIONS, msgBurst = MSG_BURST, msgPerSecond = MSG_PER_S } = {}) {
    const wss = new WebSocketServer({ port, path: "/mp", maxPayload: 64 * 1024 });
    const sessions = new Map();
    const sessionOf = new WeakMap();

    // a broadcast hands the same msg object to every recipient: serialize it once
    const serialized = new WeakMap();
    const send = (ws, msg) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > MAX_BUFFERED) return ws.terminate();
        if (!serialized.has(msg)) serialized.set(msg, JSON.stringify({ ...msg, serverNow: Date.now() }));
        ws.send(serialized.get(msg));
    };

    const newCode = () => {
        let code;
        do {
            code = Array.from({ length: 4 }, () => CODE_CHARS[randomInt(CODE_CHARS.length)]).join("");
        } while (sessions.has(code));
        return code;
    };

    // under load the longest idle session nobody is connected to makes room, so clients that walk away cannot lock others out
    // ponytail: one client holding maxSessions live sockets still fills the server; a per-IP cap needs the real client IP from the proxy chain
    const evictOrphan = () => {
        const oldest = [...sessions.values()].filter(s => s.isIdle(0)).sort((a, b) => a.lastActivity - b.lastActivity)[0];
        if (oldest) sessions.delete(oldest.code);
    };

    const route = (ws, msg) => {
        if (["create", "join", "watch", "check"].includes(msg.type)) {
            // the client opens a new socket for every attempt: one per socket means spamming sessions or guessing codes costs a connection each
            if (ws.greeted) return send(ws, { type: "error", code: "INVALID" });
            ws.greeted = true;
        }
        if (msg.type === "create") {
            if (sessions.size >= maxSessions) evictOrphan();
            // bounds memory and keeps newCode() far from exhausting the 32^4 code space
            if (sessions.size >= maxSessions) return send(ws, { type: "error", code: "SERVER_BUSY" });
            const session = new Session(newCode(), { send });
            if (session.create(ws, msg)) {
                sessions.set(session.code, session);
                sessionOf.set(ws, session);
            }
            return;
        }
        if (["join", "watch", "check"].includes(msg.type)) {
            const session = typeof msg.code === "string" && sessions.get(msg.code.toUpperCase());
            if (!session) return send(ws, { type: "error", code: "SESSION_NOT_FOUND" });
            // a check binds nothing: its close is no player leaving and no activity that keeps an orphaned session alive
            if (msg.type === "check") return session.check(ws, msg.token);
            const ok = msg.type === "join" ? session.join(ws, msg) : session.watch(ws);
            if (ok) sessionOf.set(ws, session);
            return;
        }
        const session = sessionOf.get(ws);
        if (!session) return send(ws, { type: "error", code: "INVALID" });
        session.handle(ws, msg);
    };

    // token bucket: refilled by the time since the last frame, so it costs nothing while a connection is quiet.
    // A monotonic clock: the system clock may step back (NTP, a VM waking up), and a negative pause would cut off everyone
    const allowed = (ws) => {
        const now = performance.now();
        ws.allowance = Math.min(msgBurst, ws.allowance + (now - ws.lastFrame) * msgPerSecond / 1000);
        ws.lastFrame = now;
        if (ws.allowance < 1) return false;
        ws.allowance--;
        return true;
    };

    wss.on("connection", (ws) => {
        ws.isAlive = true;
        ws.allowance = msgBurst;
        ws.lastFrame = performance.now();
        ws.on("pong", () => { ws.isAlive = true; });
        ws.on("message", (data) => {
            if (!allowed(ws)) return ws.terminate();
            let msg;
            try {
                msg = JSON.parse(data);
            } catch {
                return send(ws, { type: "error", code: "INVALID" });
            }
            if (!msg || typeof msg !== "object" || Array.isArray(msg)) return send(ws, { type: "error", code: "INVALID" });
            try {
                route(ws, msg);
            } catch (err) {
                // one bad frame must never take the whole process (and every session in memory) down
                console.error(err);
                send(ws, { type: "error", code: "INVALID" });
            }
        });
        ws.on("close", () => sessionOf.get(ws)?.disconnect(ws));
        // oversized/malformed frames surface here; without a listener Node would crash the whole process
        ws.on("error", () => ws.terminate());
    });

    const ticker = setInterval(() => {
        for (const [code, session] of sessions) {
            if (session.isIdle(idleMs)) sessions.delete(code);
            else session.tick();
        }
    }, TICK_MS);

    const heartbeat = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) {
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, HEARTBEAT_MS);

    wss.on("close", () => {
        clearInterval(ticker);
        clearInterval(heartbeat);
    });

    return wss;
}

// pm2 (fork mode, ESM) launches this file through its own wrapper, so process.argv[1]
// points at pm2 internals rather than this script: the argv check alone misses that case,
// so also trust pm_id, which pm2 sets on every process it manages
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun || process.env.pm_id !== undefined) {
    const { config } = await import("dotenv");
    config();
    const port = Number(process.env.MP_PORT) || 3001;
    startServer({ port });
    console.log(`SquadGuessr multiplayer server listening on :${port}/mp`);
}
