import i18next from "i18next";
import { LatLngBounds } from "leaflet";
import QRCode from "qrcode";
import { guessMarker } from "./guessMarker.js";
import { updateOffset, secondsUntil } from "./clock.js";
import { copyText } from "./clipboard.js";
import Preloader from "./preloader.js";
import { findMap, basemapUrl } from "./data/maps.js";
import { rankMoves } from "./scoring.js";
import { CHAT_MAX, CHAT_GAP_MS, CHAT_HISTORY } from "./chatLimits.js";
import { Teams, TEAM_COLORS, teamDot, teamName, formatPoints } from "./multiplayerTeams.js";

const RETRY_DELAYS = [1000, 2000, 5000];
// NEXT / RESULTS stay locked until the server answers, or at most this long (e.g. the connection just dropped)
const NEXT_UNLOCK_MS = 5000;
// a held Enter clicks READY ~30 times a second: one toggle per this many ms keeps the client under the server's
// message limit (server/index.js), which would otherwise cut it off
const READY_GAP_MS = 300;
// from here on the open chat would cover NEXT and the ranking at the reveal (lobby.scss docks it only above)
const SMALL_SCREEN = "(max-width: 1100px)";

/**
 * Multiplayer session client
 * Talks to server/index.js over WebSocket and drives the lobby, game and results screens
 */
export default class Multiplayer {
    constructor(app) {
        this.app = app;
        this.active = false;
        this.watching = false;
        this.ws = null;
        this.hello = null;
        this.me = null;
        this.code = null;
        this.state = null;
        this.offset = null;
        this.retry = 0;
        this.retryTimer = null;
        this.qrCode = null;
        this.answered = false;
        this.countdown = null;
        this.preloader = new Preloader();
        // the images of the round on screen, once they had their first try: preloading the next round waits for it
        this.visible = Promise.resolve();
        this.nextTimer = null;
        // the guess request of a START click that is still running, null otherwise
        this.guessFetch = null;
        // ticks the start / next round countdown on between two states, null when none runs
        this.statusTimer = null;
        // this player just handed the host role over: losing it is no news to them
        this.gaveHost = false;
        // the socket of a REJOIN check that is still waiting for its answer, null otherwise
        this.resumeCheck = null;
        // the session the REJOIN hint on screen offers
        this.resumeCode = null;
        // chat: panel open (remembered per device), lines from others that came in while it was closed, when the
        // own last line went out (performance.now)
        this.chatOpen = localStorage.getItem("mp:chatOpen") === "1";
        this.unread = 0;
        this.chatAt = -Infinity;
        // when READY was last toggled (performance.now)
        this.readyAt = -Infinity;
        // the chat log stands at its newest line (kept up to date by its scroll events)
        this.chatPinned = true;
        // team play: the lobby's teams, the teammates' guesses
        this.teams = new Teams(this);
    }

    init() {
        $("#BUTTON_MP").on("click", () => {
            $("#mpEntry").removeClass("invite running");
            // a new session starts in the mode picked on the menu
            $("#mpMode").val(this.app.selectedMode);
            this.showEntry();
        });
        // Enter joins: always from the code field, from the name field only on an invite link (no create choice there)
        $("#mpCode").on("keydown", (e) => { if (e.key === "Enter") this.join($("#mpCode").val()); });
        $("#mpName").on("keydown", (e) => {
            if (e.key === "Enter" && $("#mpEntry").hasClass("invite")) this.join($("#mpCode").val());
        });
        $("#BUTTON_MP_BACK").on("click", () => {
            // a connection attempt may still be retrying (e.g. server unreachable): abandon it
            if (this.active) this.stop();
            this.app.toMenu();
        });
        $("#BUTTON_MP_CREATE").on("click", () => this.create());
        $("#BUTTON_MP_JOIN").on("click", () => this.join($("#mpCode").val()));
        $("#BUTTON_MP_LEAVE").on("click", () => { if (this.confirmLeave()) this.leave(); });
        $("#BUTTON_MP_START").on("click", () => this.start());
        $("#BUTTON_MP_READY").on("click", () => {
            const me = this.state?.players.find(p => p.id === this.me);
            if (!me || performance.now() - this.readyAt < READY_GAP_MS) return;
            this.readyAt = performance.now();
            this.send({ type: "lobbyReady", ready: !me.lobbyReady });
        });
        $("#BUTTON_MP_CANCEL").on("click", () => {
            // one click is enough: a second one would only arrive after the start is off (INVALID); renderLobbyButtons unlocks
            $("#BUTTON_MP_CANCEL").prop("disabled", true);
            this.send({ type: "cancelStart" });
        });
        $("#BUTTON_MP_WATCH").on("click", () => this.watchCode($("#mpCode").val()));
        $("#BUTTON_MP_ENDROUND").on("click", () => this.send({ type: "endRound" }));
        $("#BUTTON_MP_COPY_JOIN").on("click", () => this.copyLink("#mpJoinUrl", "mp.joinLinkCopied"));
        $("#BUTTON_MP_COPY_WATCH").on("click", () => this.copyLink("#mpWatchUrl", "mp.watchLinkCopied"));
        $("#mpTeamList").on("click", ".mp-team-head", (e) => this.send({ type: "team", team: Number(e.currentTarget.dataset.team) }));
        $("#BUTTON_MP_SHUFFLE").on("click", () => this.send({ type: "shuffle" }));
        $("#mpSettings select").on("change", () => this.send({ type: "settings", settings: this.readSettings() }));
        $("#mpPlayers, #mpTeamList").on("click", ".mp-promote, .mp-kick, .mp-lead", (e) => {
            const { id, action } = e.currentTarget.dataset;
            const name = this.state?.players.find(p => p.id === id)?.name;
            // a plain-text dialog: the name must not come out escaped
            if (!confirm(i18next.t(`mp.confirm.${action}`, { ns: "common", name, interpolation: { escapeValue: false } }))) return;
            if (action === "promote") this.gaveHost = true;
            this.send({ type: action, playerId: id });
        });
        $("#BUTTON_MP_CHAT").on("click", () => this.toggleChat(!this.chatOpen));
        $("#BUTTON_MP_CHAT_CLOSE").on("click", () => this.toggleChat(false));
        $("#mpChat").on("keydown", (e) => { if (e.key === "Escape") this.toggleChat(false); });
        // the footer blocks the context menu: in the chat it is needed to paste, and on phones to select text
        $("#mpChat").on("contextmenu", (e) => e.stopPropagation());
        // a tap on the send arrow would take the focus from the input: the phone's keyboard would close after every line
        $("#BUTTON_MP_CHAT_SEND").on("mousedown", (e) => e.preventDefault());
        const log = document.getElementById("mpChatLog");
        log.addEventListener("scroll", () => { this.chatPinned = log.scrollHeight - log.scrollTop - log.clientHeight < 40; });
        // a new size (a turned tablet, the chat docking or not) leaves the scroll position behind: whoever was at the
        // newest line stays there, whoever scrolled up to read stays where they are
        new ResizeObserver(() => { if (this.chatPinned) log.scrollTop = log.scrollHeight; }).observe(log);
        // UTF-16 units, never more than the server keeps (CHAT_MAX characters as seen)
        $("#mpChatInput").attr("maxlength", CHAT_MAX);
        $("#mpChatForm").on("submit", (e) => {
            e.preventDefault();
            const text = $("#mpChatInput").val().trim();
            // offline (the banner says reconnecting): the text stays for another try
            if (!text || this.ws?.readyState !== WebSocket.OPEN) return;
            // too soon after the last line: it stays in the field, nothing goes out
            if (performance.now() - this.chatAt < CHAT_GAP_MS) return this.toast("warning", "mp.errors.CHAT_TOO_FAST");
            this.chatAt = performance.now();
            this.send({ type: "chat", text });
            $("#mpChatInput").val("");
        });
        $(".mp-resume-join").on("click", () => {
            // the token gets us back in: a name field emptied in the entry form must not block that
            if (!$("#mpName").val().trim()) $("#mpName").val(localStorage.getItem("mp:name") ?? "");
            this.join(this.resumeCode);
        });
        $(".mp-resume-dismiss").on("click", () => {
            this.unpoint(this.resumeCode);
            this.closeResume();
        });
        document.addEventListener("visibilitychange", () => this.onVisible());
        // a page left for another one can live on in the back/forward cache with its socket open (the browser even
        // answers the server's pings), so the game would keep waiting for this player. Closed, it is a dropped
        // connection with its reconnect window; coming back reconnects (onclose retry / onVisible)
        window.addEventListener("pagehide", () => this.ws?.close());

        $("#mpName").val(localStorage.getItem("mp:name") ?? "");

        const params = new URLSearchParams(location.search);
        const watch = params.get("watch");
        const join = params.get("join")?.toUpperCase();
        if (watch) return this.watch(watch);
        if (!join) return;
        $("#mpCode").val(join);
        // invite link: only ask for the name, no "create session" and no code field
        $("#mpEntry").addClass("invite");
        // page reload during a game: rejoin silently with the stored token
        if (localStorage.getItem(`mp:${join}`) && $("#mpName").val()) return this.join(join);
        this.showEntry();
        // meanwhile ask what the link leads to: an open lobby keeps the form, a running game offers to watch,
        // a finished one (or an old code after PLAY AGAIN) shows its results
        this.open({ type: "peek", code: join, token: localStorage.getItem(`mp:${join}`) ?? undefined });
    }

    // ===== ENTRY =====

    readName() {
        const name = $("#mpName").val().trim();
        if (!name) {
            this.toast("warning", "mp.enterName");
            return null;
        }
        localStorage.setItem("mp:name", name);
        return name;
    }

    readSettings() {
        const rush = $("#mpTimer").val() === "rush";
        const mode = $("#mpMode").val();
        return {
            mode,
            timer: Number(rush ? $("#mpRush").val() : $("#mpTimer").val()),
            rounds: Number($("#mpRounds").val()),
            // 0: the host moves on with NEXT
            next: $("#mpNext").val() === "auto" ? Number($("#mpNextDelay").val()) : 0,
            keepCode: $("#mpKeepCode").val() === "1",
            // team play is classic only: switching to Find the Map turns it off
            team: mode === "classic" ? $("#mpTeam").val() : "off",
            teams: Number($("#mpTeamCount").val()),
            penalty: $("#mpPenalty").val() === "on",
            decide: Number($("#mpDecide").val()),
        };
    }

    create() {
        const name = this.readName();
        if (name) this.open({ type: "create", name, settings: this.readSettings() });
    }

    join(rawCode) {
        const code = String(rawCode).trim().toUpperCase();
        const name = this.readName();
        if (!name) return;
        if (code.length !== 4) return this.toast("warning", "mp.errors.CODE");
        this.open({ type: "join", code, name, token: localStorage.getItem(`mp:${code}`) ?? undefined });
    }

    // watch instead of playing (also offered when it is too late to play): the same page turns into the big screen
    watchCode(rawCode) {
        const code = String(rawCode).trim().toUpperCase();
        if (code.length !== 4) return this.toast("warning", "mp.errors.CODE");
        $("#mpEntry").removeClass("running");
        this.watch(code);
    }

    watch(code) {
        this.open({ type: "watch", code: code.toUpperCase() });
    }

    start() {
        // spins on through the loading phase (renderStatus) until the first round starts; a lobby state that comes
        // in while the guesses are still being fetched (someone joins) must not hand the button back
        const fetching = this.app.getGuess(this.state.settings.rounds);
        this.guessFetch = fetching;
        this.app.setButtonLoading($("#BUTTON_MP_START"), true);
        // stop() forgets the request: guesses that arrive after leaving must not start a game in another session
        const current = () => this.guessFetch === fetching;
        fetching
            .then(guesses => { if (current()) this.send({ type: "start", guesses }); })
            .catch(() => {
                if (!current()) return;
                // from the state, not just the spinner off: the last guest may have left while the guesses loaded
                this.guessFetch = null;
                this.renderLobbyButtons(this.state, false);
                this.toast("error", "mp.errors.GUESSES");
            })
            .finally(() => { if (current()) this.guessFetch = null; });
    }

    /**
     * NEXT / RESULTS: locked until the server answers, so a double click or a held space bar sends only one
     */
    next() {
        this.app.BUTTON_NEXT.prop("disabled", true);
        this.app.BUTTON_RESULTS.prop("disabled", true);
        clearTimeout(this.nextTimer);
        this.nextTimer = setTimeout(() => {
            this.app.BUTTON_NEXT.prop("disabled", false);
            this.app.BUTTON_RESULTS.prop("disabled", false);
        }, NEXT_UNLOCK_MS);
        this.send({ type: "next" });
    }

    // ===== CONNECTION =====

    open(hello) {
        // a second click (or a click while reconnecting) replaces the previous attempt instead of adding a socket
        clearTimeout(this.retryTimer);
        const previous = this.ws;
        this.ws = null;
        previous?.close();
        this.hello = hello;
        // on the way into a session: no hint, and a check still running must not bring it back
        this.closeResume();
        // a JOIN clicked while a watch attempt still connects makes this a player again
        this.watching = hello.type === "watch";
        this.active = true;
        this.retry = 0;
        $("body").addClass("mp-active");
        this.connect();
    }

    connect() {
        const ws = new WebSocket(this.socketUrl());
        this.ws = ws;
        this.offset = null;
        ws.onopen = () => {
            if (this.ws !== ws) return;
            this.retry = 0;
            $("#mpBanner").prop("hidden", true);
            this.send(this.hello);
        };
        ws.onmessage = (event) => { if (this.ws === ws) this.onMessage(JSON.parse(event.data)); };
        ws.onclose = () => {
            if (!this.active || this.ws !== ws) return;
            $("#mpBanner").prop("hidden", false);
            clearTimeout(this.retryTimer);
            this.retryTimer = setTimeout(() => this.connect(), RETRY_DELAYS[this.retry++] ?? 5000);
        };
    }

    socketUrl() {
        const protocol = location.protocol === "https:" ? "wss" : "ws";
        return `${protocol}://${location.host}/mp`;
    }

    /**
     * Asks the server whether the last session we played in still knows our token, and offers the way back.
     * On a socket of its own: a check is nobody in the session. No retry: without an answer there is no hint
     */
    checkResume() {
        this.closeResume();
        const code = localStorage.getItem("mp:last");
        const token = code && localStorage.getItem(`mp:${code}`);
        if (!token) return;
        const ws = new WebSocket(this.socketUrl());
        this.resumeCheck = ws;
        ws.onopen = () => ws.send(JSON.stringify({ type: "check", code, token }));
        ws.onmessage = (event) => {
            ws.close();
            // a newer check took over, or we are in a session again by now (e.g. the silent rejoin after a reload)
            if (this.resumeCheck !== ws || this.active) return;
            this.resumeCheck = null;
            const msg = JSON.parse(event.data);
            if (msg.type !== "resumable") return this.unpoint(code);
            this.showResume(msg);
        };
    }

    showResume({ code, phase, round, total }) {
        this.resumeCode = code;
        const text = phase === "lobby"
            ? i18next.t("mp.resume.lobby", { ns: "common", code })
            : i18next.t("mp.resume.game", { ns: "common", code, round: round + 1, total });
        $(".mp-resume-text").text(text);
        $(".mp-resume").prop("hidden", false);
    }

    closeResume() {
        this.resumeCheck?.close();
        this.resumeCheck = null;
        $(".mp-resume").prop("hidden", true);
    }

    onVisible() {
        if (!this.active || document.visibilityState !== "visible") return;
        if (this.ws?.readyState !== WebSocket.CLOSED) return;
        clearTimeout(this.retryTimer);
        this.connect();
    }

    send(msg) {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
    }

    stop() {
        this.active = false;
        this.watching = false;
        clearTimeout(this.retryTimer);
        clearInterval(this.countdown);
        clearInterval(this.statusTimer);
        clearTimeout(this.nextTimer);
        this.guessFetch = null;
        // the lock ends with the game: singleplayer never unlocks RESULTS itself
        this.app.BUTTON_NEXT.prop("disabled", false);
        this.app.BUTTON_RESULTS.prop("disabled", false);
        // no retries or held images beyond the game; a preload still waiting to start sees the new preloader and stops
        this.preloader.keep([]);
        this.preloader = new Preloader();
        this.visible = Promise.resolve();
        this.answered = false;
        this.teams.clear();
        this.roundIndex = null;
        this.revealIndex = null;
        this.unread = 0;
        $("#mpChatLog").empty();
        $("#mpChatInput").val("");
        this.gaveHost = false;
        // the game screen is gone: a round seen again later (watching this session after leaving it) must count as fresh
        this.app.currentGuess = null;
        this.app.selectMode($(".mode-card.selected").data("mode") || "classic");
        const ws = this.ws;
        this.ws = null;
        ws?.close();
        this.state = null;
        this.me = null;
        this.code = null;
        $("body").removeClass("mp-active mp-host watch-mode mp-reveal mp-chat mp-chat-open");
        $("#mpBanner, #mpStatus, #mpRanking, #BUTTON_MP_ENDROUND").prop("hidden", true);
        this.app.INPUT_GUESS.prop("disabled", false);
    }

    leave() {
        this.send({ type: "leave" });
        // only the lobby drops the player for good; from the countdown on the token is the way back (REJOIN hint).
        // A big-screen tab never held a player token: it must not drop the one the player tab next to it uses
        if (this.state?.phase === "lobby" && !this.watching) this.forget(this.code);
        this.stop();
        this.app.toMenu();
    }

    /**
     * Leaving the lobby is final (the server drops the player, the token dies): asked first. Anywhere else the REJOIN
     * hint brings the player back, and a big screen never was one. Only for clicks: onError leaves without asking
     */
    confirmLeave() {
        if (this.watching || this.state?.phase !== "lobby") return true;
        return confirm(i18next.t("mp.confirmLeave", { ns: "common" }));
    }

    /**
     * Drops a stored token that cannot get us back in any more, and the REJOIN pointer to it
     */
    forget(code) {
        localStorage.removeItem(`mp:${code}`);
        this.unpoint(code);
    }

    /**
     * No REJOIN hint for this session any more. Its token stays: another tab of this browser may still play with it,
     * and its reload needs it (a dead token does no harm)
     */
    unpoint(code) {
        if (localStorage.getItem("mp:last") === code) localStorage.removeItem("mp:last");
    }

    // ===== MESSAGES =====

    onMessage(msg) {
        if (msg.serverNow) this.offset = updateOffset(this.offset, msg.serverNow, Date.now());

        switch (msg.type) {
        case "welcome":
            // PLAY AGAIN gave the session a new code: the token moves on to it
            if (this.hello.code && this.hello.code !== msg.code) localStorage.removeItem(`mp:${this.hello.code}`);
            this.me = msg.playerId;
            this.code = msg.code;
            localStorage.setItem(`mp:${msg.code}`, msg.token);
            // the session the REJOIN hint asks about (see checkResume)
            localStorage.setItem("mp:last", msg.code);
            this.hello ={ type: "join", code: msg.code, name: this.hello.name, token: msg.token };
            history.replaceState({}, "", `/?join=${msg.code}`);
            // a new connection has nothing in flight: a CANCEL lost with the old one can be clicked again
            $("#BUTTON_MP_CANCEL").prop("disabled", false);
            // the history replaces what is on screen: after a reload or a dropped connection nothing shows twice,
            // and it starts at its newest line
            $("#mpChatLog").empty();
            this.chatPinned = true;
            // an older server sends no history
            (msg.chat ?? []).forEach(line => this.addChatLine(line));
            break;
        case "state":
            // like welcome for a player: only once the server took the code does the page turn into the big screen and
            // the address into its link (a reload keeps watching); until then the entry form, BACK included, stays usable
            if (this.watching && !this.state) {
                $("body").addClass("watch-mode");
                history.replaceState({}, "", `/?watch=${msg.code}`);
            }
            this.onHostChange(this.state?.hostId, msg.hostId);
            this.onTeamChange(this.state, msg);
            this.state = msg;
            this.renderState();
            break;
        case "prepare":
            this.onPrepare(msg);
            break;
        case "round":
            this.onRound(msg);
            break;
        case "reveal":
            this.onReveal(msg);
            break;
        case "final":
            this.onFinal(msg);
            break;
        case "chat":
            this.onChat(msg);
            break;
        case "teamGuesses":
            this.teams.showGuesses(msg);
            break;
        case "decide":
            this.onDecide(msg);
            break;
        case "left":
            this.toast("info", "mp.left", { name: msg.name });
            break;
        case "unready":
            this.toast("info", "mp.unready");
            break;
        case "joinable":
            // the invite link leads into an open lobby: the form is already there, only the look ends
            this.stop();
            // the look (open) closed the REJOIN hint the entry form asks for
            this.checkResume();
            break;
        case "ended":
            this.onEnded(msg);
            break;
        case "shuffled":
            // the state with the new teams comes right after: onTeamChange tells the player
            this.shuffled = true;
            break;
        case "error":
            this.onError(msg.code, msg);
            break;
        }
    }

    onError(code, details) {
        // a rejected start brings no new state, so the START spinner would stay
        if (this.state?.phase === "lobby" && !this.guessFetch) this.renderLobbyButtons(this.state, false);
        if (code === "GAME_RUNNING") {
            // no toast: the entry form now explains it and offers to watch instead (with the code, even after a rejoin)
            $("#mpCode").val(this.hello?.code);
            this.stop();
            $("#mpEntry").addClass("running");
            return this.showEntry();
        }
        if (code === "REPLACED") {
            // the same player went on in another tab or on another device, which keeps using the stored token
            this.stop();
            this.app.toMenu();
            return this.toast("warning", "mp.errors.REPLACED");
        }
        if (code === "KICKED") {
            // the stored token stays: the server knows this device again and lets it back in once the wait is over
            this.stop();
            this.app.toMenu();
            return this.toast("error", "mp.errors.KICKED", { seconds: details.seconds });
        }
        this.toast("error", `mp.errors.${code}`);
        // a stored token for a dead session is useless; one turned away for a taken name is not: from an old code
        // it still leads its player into the next lobby, under another name
        if (code === "SESSION_NOT_FOUND") this.forget(this.hello?.code);
        const rejected = ["SESSION_NOT_FOUND", "NAME_TAKEN", "NAME_INVALID", "SESSION_FULL", "SERVER_BUSY"].includes(code);
        if (!rejected) return;
        // back to the menu: were in the session (server restart, dropped from the lobby), a big-screen link, or an invite
        // link whose form cannot fix it (dead or full session; the form only lets you change the name)
        const invite = $("#mpEntry").hasClass("invite");
        const watchLink = Boolean(new URLSearchParams(location.search).get("watch"));
        const nameProblem = code === "NAME_TAKEN" || code === "NAME_INVALID";
        if (this.state || watchLink || (invite && !nameProblem)) return this.leave();
        // wrong code (to play or to watch), taken or unusable name: stay on the form to correct it
        // (an automatic rejoin after a reload never showed the form, hence showEntry)
        this.stop();
        this.showEntry();
    }

    /**
     * Tells this player when the host role came to them, or went away without their doing (the time after a game ran
     * out, or they were gone for longer than a reload takes); never on the first state, never on the big screen
     */
    onHostChange(before, now) {
        if (!before || before === now || this.watching) return;
        if (now === this.me) this.toast("success", "mp.nowHost");
        if (before !== this.me) return;
        if (!this.gaveHost) this.toast("warning", "mp.noLongerHost");
        this.gaveHost = false;
    }

    /**
     * Tells this player their team after the host shuffled, and in Leader when they came to lead a team (handed over,
     * the leader left, a switch into an empty team, a shuffle); never on the first state, never on the big screen.
     * One toast per change, the page has room for one: the team or the lead as its headline, a shuffle as the line below
     */
    onTeamChange(before, now) {
        const shuffled = this.shuffled;
        this.shuffled = false;
        const was = before?.players.find(p => p.id === this.me);
        const is = now.players.find(p => p.id === this.me);
        if (!was || !is) return;
        const team = teamName(is.team);
        const leads = now.settings.team === "leader" && is.leader;
        if (shuffled) return this.toast(leads ? "success" : "info", leads ? "mp.nowLeader" : "mp.nowIn", { team }, "mp.shuffled");
        const led = before.settings.team === "leader" && was.leader && was.team === is.team;
        if (leads && !led) this.toast("success", "mp.nowLeader", { team });
    }

    // ===== RENDERING =====

    isHost() {
        return this.me !== null && this.state?.hostId === this.me;
    }

    /**
     * This player's team in team play (undefined on the big screen)
     */
    myTeam() {
        return this.state?.players.find(p => p.id === this.me)?.team;
    }

    /**
     * Leader: this player leads their team, so guesses nothing and picks the team's guess instead
     */
    isLeading() {
        return this.state?.settings.team === "leader" && Boolean(this.state.players.find(p => p.id === this.me)?.leader);
    }

    /**
     * May this player place a guess marker now: not as a leader, and not while the leaders decide
     */
    mayGuess() {
        return this.state?.phase !== "decide" && !this.isLeading();
    }

    /**
     * Whether this player still has a choice to make before the time runs out, which the timer warns about (squadGuessr):
     * the guess in the round, except for a leader, who guesses nothing; while the leaders decide, the leader's pick. A
     * selected but unsent pick counts when the time runs out, like a placed marker
     */
    stillToChoose() {
        if (this.state?.phase === "decide") return this.teams.picking && !this.teams.selected;
        return !this.answered && !this.isLeading() && !this.app.minimap.guessMarker;
    }

    renderState() {
        const s = this.state;
        this.code = s.code;
        $("body").toggleClass("mp-host", this.isHost());
        $("#mpRoomCode").text(s.code);
        $("#mpMode").val(s.settings.mode);
        const { timer, next } = s.settings;
        // the seconds selects keep their last choice while hidden, so switching back brings it again
        const rush = timer > 0 && timer < 60;
        $("#mpTimer").val(rush ? "rush" : String(timer));
        $("#mpRush").prop("hidden", !rush);
        if (rush) $("#mpRush").val(String(timer));
        $("#mpRounds").val(String(s.settings.rounds));
        $("#mpNext").val(next ? "auto" : "0");
        $("#mpNextDelay").prop("hidden", !next);
        if (next) $("#mpNextDelay").val(String(next));
        $("#mpKeepCode").val(s.settings.keepCode ? "1" : "0");
        const team = s.settings.team ?? "off";
        $("#mpTeam").val(team);
        $("#mpTeamCount").prop("hidden", team === "off");
        $(".mp-penalty").prop("hidden", team !== "sum");
        $(".mp-decide").prop("hidden", team !== "leader");
        // without teams the settings carry no team fields: the hidden selects keep their last choice for switching back
        if (s.settings.team) {
            $("#mpTeamCount").val(String(s.settings.teams));
            $("#mpPenalty").val(s.settings.penalty ? "on" : "off");
            $("#mpDecide").val(String(s.settings.decide));
        }
        $("#mpSettingsSummary").text(this.describeSettings(s.settings));
        this.renderPlayers(s);

        const me = s.players.find(p => p.id === this.me);
        // team play: the score in the corner is the team's, a player's own counts for nothing
        if (me) $("#totalPoints").text(s.settings.team ? s.teamScores?.[me.team] ?? 0 : me.score);

        this.renderStatus();
        this.renderChat();
        if (s.phase === "lobby") {
            // a start that was called off leaves nothing loading or retrying behind
            this.preloader.keep([]);
            if (this.backInLobby(s)) this.showRoom();
        }
        // a page that (re)opened while everyone waits for the images: the room shows who is loading, not the menu
        if (s.phase === "loading" && !$("#map_ui").is(":visible")) this.showRoom();
    }

    /**
     * After a game each player stays on the final ranking until their own PLAY AGAIN, the big screen until the host's;
     * whoever is still on the last reveal (the lobby came before the final) gets the ranking from it
     */
    backInLobby(s) {
        const back = s.players.find(p => p.id === (this.watching ? s.hostId : this.me))?.back;
        // undefined: a server from before PLAY AGAIN for everyone
        if (back !== false) return true;
        if ($("#results").is(":visible")) return false;
        if ($("#map_ui").is(":visible") && this.lastReveal) {
            this.finalFromReveal();
            return false;
        }
        // a reload lost the results: nothing to stay for
        if (!this.watching) this.send({ type: "lobby" });
        return true;
    }

    /**
     * Status line and host controls, from the state alone: a player who becomes host mid-game gets the controls at once
     */
    renderStatus() {
        const s = this.state;
        if (!s) return;
        const host = this.isHost();
        const last = s.round + 1 === s.total;
        const loading = s.phase === "loading";
        // round 1 is on its way (countdown, then maybe slow devices): the host can still call it off
        const starting = loading && s.round === 0;
        $("#BUTTON_MP_ENDROUND").prop("hidden", s.phase !== "round" || !host || s.settings.timer > 0);
        // any answer from the server unlocks NEXT / RESULTS (see next())
        clearTimeout(this.nextTimer);
        // with settings.next the countdown alone moves on
        this.app.BUTTON_NEXT.prop({ hidden: s.phase !== "reveal" || !host || last || Boolean(s.settings.next), disabled: false });
        // after the last round every player may look at the results; the big screen follows the host
        this.app.BUTTON_RESULTS.prop({ hidden: s.phase !== "reveal" || !last || this.watching, disabled: false });
        this.renderLobbyButtons(s, starting);
        // the lobby stays on screen while the first round loads: the start went through, the settings are fixed
        $("#mpSettings select").prop("disabled", s.phase !== "lobby");
        // team play is classic only
        $("#mpTeam").prop("disabled", s.phase !== "lobby" || s.settings.mode !== "classic");
        $("#mpWaitingForHost").prop("hidden", loading);
        $("#mpLobbyStatus").prop("hidden", !loading);
        clearInterval(this.statusTimer);
        if (loading) {
            this.renderLoadingStatus();
            if (s.startsAt !== null) this.statusTimer = setInterval(() => this.renderLoadingStatus(), 250);
            $("#mpStatus").prop("hidden", false);
            return;
        }
        if (s.phase === "reveal" && s.nextAt !== null) {
            this.renderNextStatus();
            this.statusTimer = setInterval(() => this.renderNextStatus(), 250);
            $("#mpStatus").prop("hidden", false);
        } else if (s.phase === "reveal") {
            $("#mpStatus").text(i18next.t("mp.waitingForHost", { ns: "common" })).prop("hidden", host || (last && !this.watching));
        }
        if (s.phase === "decide") {
            const picked = s.players.filter(p => p.picked).length;
            const text = this.teams.picking
                ? i18next.t("mp.pickGuess", { ns: "common" })
                : i18next.t("mp.leadersDeciding", { ns: "common", picked, total: this.decideTeams?.length ?? 0 });
            $("#mpStatus").text(text).prop("hidden", false);
            return;
        }
        // Leader: the leader waits for the team, and sees how far it is
        if (s.phase === "round" && this.isLeading()) {
            const team = s.players.filter(p => p.connected && p.team === this.myTeam() && p.id !== this.me);
            $("#mpStatus").text(i18next.t("mp.teamGuessing", { ns: "common", answered: team.filter(p => p.answered).length, total: team.length })).prop("hidden", false);
            return;
        }
        if (s.phase !== "round") return;
        const online = s.players.filter(p => p.connected);
        const text = i18next.t("mp.waitingForPlayers", {
            ns: "common",
            answered: online.filter(p => p.answered).length,
            total: online.length,
        });
        $("#mpStatus").text(text).prop("hidden", !this.answered && !this.watching);
    }

    /**
     * READY for guests, START and CANCEL for the host
     */
    renderLobbyButtons(s, starting) {
        const me = s.players.find(p => p.id === this.me);
        $("#BUTTON_MP_READY").prop("hidden", s.phase !== "lobby").attr("aria-pressed", String(Boolean(me?.lobbyReady)));
        const $start = $("#BUTTON_MP_START");
        this.app.setButtonLoading($start, Boolean(this.guessFetch));
        $start.prop("hidden", starting);
        // always START, so the buttons keep their places; not while it spins, the spinner keeps it locked
        if (!this.guessFetch) {
            $start.prop("disabled", !s.canStart).toggleClass("all-ready", s.allReady);
            // through data-i18n-title, so a language switch keeps the tooltip
            // in team play with somebody else there, what is missing is the variant's team rule
            const key = s.settings.team && s.players.some(p => p.connected && p.id !== s.hostId) ? `mp.needTeams.${s.settings.team}` : "mp.needPlayers";
            if (s.canStart) $start.removeAttr("title data-i18n-title");
            else $start.attr({ "data-i18n-title": `common:${key}`, title: i18next.t(key, { ns: "common" }) });
        }
        $("#BUTTON_MP_CANCEL").prop("hidden", !starting);
        // a clicked CANCEL stays locked until the start is off or round 1 runs
        if (!starting) $("#BUTTON_MP_CANCEL").prop("disabled", false);
        $("#BUTTON_MP_SHUFFLE").prop("hidden", s.phase !== "lobby" || !s.settings.team);
    }

    /**
     * Status line while a round waits: before round 1 the countdown, then how many have their images (statusTimer ticks it)
     */
    renderLoadingStatus() {
        const s = this.state;
        const left = s.startsAt === null ? 0 : secondsUntil(s.startsAt, this.offset, Date.now());
        if (left === 0) clearInterval(this.statusTimer);
        const waited = s.players.filter(p => p.connected && !p.stalled);
        const text = left > 0
            ? i18next.t("mp.startingIn", { ns: "common", seconds: left })
            : i18next.t("mp.loadingImages", { ns: "common", ready: waited.filter(p => p.ready).length, total: waited.length });
        $("#mpStatus, #mpLobbyStatus").text(text);
    }

    /**
     * Status line while the reveal counts down to the next round (or the results), for everyone
     */
    renderNextStatus() {
        const s = this.state;
        const left = secondsUntil(s.nextAt, this.offset, Date.now());
        if (left === 0) clearInterval(this.statusTimer);
        const key = s.round + 1 === s.total ? "mp.resultsIn" : "mp.nextIn";
        $("#mpStatus").text(i18next.t(key, { ns: "common", seconds: left }));
    }

    // ===== GAME =====

    /**
     * A round is announced: the next one while this one runs, or the one everybody waits for. Its images load in
     * the background and get reported; nothing on screen changes, so a fast device gets no head start
     */
    onPrepare(msg) {
        const urls = [this.app.hintUrl(msg.url)];
        // classic only: in Find the Map the map is the answer and never comes ahead (msg.map is null). A map this
        // (older, cached) build does not know is left out, so the hint still preloads and ready still goes out
        const map = msg.map && findMap(msg.map);
        if (map) urls.push(basemapUrl(map));
        // the round on screen keeps its images in the DOM, so only the announced ones need holding
        this.preloader.keep(urls);
        // the next round: low priority, and not before the images on screen had their first try
        const low = this.state?.phase !== "loading";
        const preloader = this.preloader;
        this.visible
            .then(() => preloader === this.preloader && preloader.load(urls, { low }))
            .then((loaded) => {
                // checked now, not when prepare came: the page may have left the game or turned into a big screen
                if (loaded && this.active && !this.watching) this.send({ type: "ready", index: msg.index });
            });
    }


    onRound(msg) {
        const app = this.app;
        const me = this.state.players.find(p => p.id === this.me);
        this.answered = Boolean(me?.answered);
        // a reconnect resends the running round: keep the marker placed / the name typed but not sent yet
        const resent = msg.index === this.roundIndex && app.currentGuess?.url === msg.url;
        this.roundIndex = msg.index;

        app.selectedMode = this.state.settings.mode;
        $("body").removeClass("mp-reveal");
        let mapShown = Promise.resolve();
        if (!resent) {
            this.teams.clear();
            app.currentGuess = { map: msg.map, url: msg.url, submitter: msg.submitter };
            app.solutionMarker = null;
            if (msg.map) mapShown = app.setupMap();
            else app.minimap.clear();
            app.INPUT_GUESS.val("");
        }

        $("#gameWrapper").toggleClass("no-map", !msg.map);
        $("#text").css("visibility", "hidden");
        $("#mpRanking").prop("hidden", true);
        $("#round").text(`${msg.index + 1}/${msg.total}`);
        app.INPUT_GUESS.prop({ hidden: false, disabled: this.answered });
        const unsent = app.minimap.guessMarker || app.INPUT_GUESS.val().trim();
        // a decision before (Leader) renamed the button
        app.BUTTON_GUESS.attr("data-i18n", "common:game.buttons.guess").text(i18next.t("game.buttons.guess", { ns: "common" }));
        app.BUTTON_GUESS.prop({ hidden: this.watching || this.answered || this.isLeading(), disabled: !unsent });

        app.switchUI("game");
        app.minimap.invalidateSize();
        if (!resent) this.visible = Promise.all([mapShown, app.setupHint()]);
        this.renderStatus();
        this.startCountdown(msg.deadline);
    }

    /**
     * Leader: the round is over for the players, the leaders pick their team's guess before the reveal. Nobody
     * guesses any more; a leader who picked already (and reloaded) does not pick again
     */
    onDecide(msg) {
        const app = this.app;
        this.decideTeams = msg.teams;
        this.answered = true;
        const me = this.state.players.find(p => p.id === this.me);
        const picking = this.isLeading() && !me?.picked && msg.teams.includes(this.myTeam());
        this.teams.startPicking(picking);
        app.BUTTON_GUESS.attr("data-i18n", "common:mp.buttons.pick").text(i18next.t("mp.buttons.pick", { ns: "common" }));
        app.BUTTON_GUESS.prop({ hidden: !picking, disabled: true });
        this.renderStatus();
        this.startCountdown(msg.deadline);
    }

    /**
     * Leader: sends the selected guess as the team's, also when the time runs out (like an answer)
     */
    submitPick() {
        if (!this.teams.picking || !this.teams.selected) return;
        this.send({ type: "pick", index: this.roundIndex, playerId: this.teams.selected });
        this.teams.lock();
        this.app.BUTTON_GUESS.prop({ hidden: true, disabled: true });
        this.renderStatus();
    }

    submitAnswer() {
        // GUESS is PICK while the leaders decide, and the countdown's end sends the selection
        if (this.state?.phase === "decide") return this.submitPick();
        const app = this.app;
        if (this.answered || this.watching || this.state?.phase !== "round") return;

        let answer;
        if (app.selectedMode === "mapFinder") {
            const mapName = app.INPUT_GUESS.val().trim();
            if (!mapName) return;
            answer = { mapName };
            app.INPUT_GUESS.prop("disabled", true);
        } else {
            const marker = app.minimap.guessMarker;
            if (!marker) return;
            const { lat, lng } = marker.getLatLng();
            answer = { lat: lat * app.minimap.mapToGameScale, lng: lng * app.minimap.mapToGameScale };
            marker.dragging.disable();
        }

        this.answered = true;
        this.send({ type: "answer", index: this.roundIndex, ...answer });
        app.BUTTON_GUESS.prop({ hidden: true, disabled: true });
        this.renderStatus();
    }

    startCountdown(deadline) {
        clearInterval(this.countdown);
        $("#timerWrapper").prop("hidden", !deadline);
        if (!deadline) return;

        const tick = () => {
            const left = secondsUntil(deadline, this.offset, Date.now());
            this.app.updateTimerDisplay(left);
            if (left > 0) return;
            clearInterval(this.countdown);
            // like singleplayer: a placed marker / typed name counts when time runs out
            this.submitAnswer();
        };
        tick();
        this.countdown = setInterval(tick, 250);
    }

    onReveal(msg) {
        const app = this.app;
        const mm = app.minimap;
        const { solution } = msg;
        // a reconnect resends the reveal: it is already on screen (drawing it again would stack every marker)
        if (msg.index === this.revealIndex && app.currentGuess?.url === solution.url) return;
        this.revealIndex = msg.index;
        this.lastReveal = msg;
        // small screens: a chat opened once the answer was in would cover the ranking, so the reveal closes it
        // (only for now, like the round does)
        if (matchMedia(SMALL_SCREEN).matches) {
            this.chatOpen = false;
            this.renderChat();
        }

        clearInterval(this.countdown);
        // the reveal shows everyone's guesses as markers of their own
        this.teams.clear();
        app.stopTimer();
        app.selectedMode = this.state.settings.mode;
        // before any map sizing: on the big screen the reveal gives the map most of the width
        $("body").addClass("mp-reveal");

        // fresh = we missed the round (reconnect straight into reveal)
        const fresh = app.currentGuess?.url !== solution.url;
        // mapFinder never drew the map during the round (even if activeMap happens to be the right one)
        const needsMap = fresh || app.selectedMode === "mapFinder" || !mm.activeMap
            || mm.activeMap.name.toLowerCase() !== solution.map.toLowerCase();
        app.currentGuess = { ...solution, submitter: fresh ? null : app.currentGuess.submitter };

        $("#gameWrapper").removeClass("no-map");
        const mapShown = needsMap ? app.setupMap() : Promise.resolve();
        let hintShown = Promise.resolve();
        if (fresh) {
            app.switchUI("game");
            hintShown = app.setupHint();
        }
        // a next round announced from now on waits for these (fresh implies needsMap)
        if (needsMap) this.visible = Promise.all([mapShown, hintShown]);
        mm.invalidateSize();

        const mine = msg.results.find(r => r.id === this.me);
        const latLng = app.getSolutionLatLng();
        app.createSolutionMarker(latLng);
        // show my guess as the server scored it; a marker placed but never sent must not look scored
        mm.guessMarker?.remove();
        mm.guessMarker = null;
        // everyone sees how far off everyone was: the others in pale cyan (red on the big screen), mine red and
        // added last so my tag and line stay on top; the z-index offset does the same for my marker
        const othersStyle = this.watching ? {} : { color: "#33d6ff", opacity: 0.5 };
        // team play: every line in its team's color
        const lineStyle = r => (msg.teams ? { color: TEAM_COLORS[r.team], opacity: 0.8 } : othersStyle);
        // Midpoint and Leader play one point per team: only that point gets a line to the solution
        const lines = !msg.teams || this.state.settings.team === "sum";
        // Leader: the team's point stands on the picked guess, so it takes that pin's place and names whose guess it was
        const picked = new Set((msg.teams ?? []).map(t => t.picked).filter(Boolean));
        msg.results
            .filter(r => r.lat !== null && r.id !== this.me && !picked.has(r.id))
            .forEach(r => {
                this.addPlayerMarker(r);
                if (lines) app.drawSolutionDistance(latLng, this.toMap(r), lineStyle(r));
            });
        if (mine && mine.lat !== null && !picked.has(mine.id)) {
            const you = { ...mine, name: i18next.t("mp.you", { ns: "common" }) };
            mm.guessMarker = this.addPlayerMarker(you, { iconClass: "mp-own", zIndexOffset: 1000 });
            if (lines) app.drawSolutionDistance(latLng);
        }
        (msg.teams ?? []).filter(t => t.lat !== null).forEach(t => {
            const by = msg.results.find(r => r.id === t.picked);
            this.teams.addTeamMarker(t, by && (by.id === this.me ? i18next.t("mp.you", { ns: "common" }) : by.name));
            app.drawSolutionDistance(latLng, this.toMap(t), { color: TEAM_COLORS[t.id], opacity: 1, weight: 4 });
        });
        this.focusReveal(latLng, [...msg.results, ...(msg.teams ?? [])]);

        // team play: the round counts for the team, so the team's points are the ones shown
        const points = msg.teams?.find(t => t.id === this.myTeam())?.points ?? mine?.points;
        if (mine) {
            $("#dist").text(mine.distance === null ? "—" : app.formatDistance(mine.distance));
            $("#points").text(points);
            $("#text").css("visibility", "visible");
        }
        const mapLabel = solution.map.charAt(0).toUpperCase() + solution.map.slice(1);
        if (app.selectedMode === "mapFinder") {
            $("#mapName").text(`${mine ? (mine.points ? "✅ " : "❌ ") : ""}${mapLabel}`).fadeIn();
        } else if (mine) {
            $("#mapName").text(`${points} ${i18next.t("shared.points", { ns: "common" })}`).fadeIn();
        }

        // team play ranks the teams; round 1 has no places to leave: everybody started at 0
        const rows = msg.teams ? msg.teams.map(t => ({ ...t, team: t.id, name: teamName(t.id) })) : msg.results;
        this.renderRanking($("#mpRanking"), rows, [], msg.index > 0 ? rankMoves(rows) : {}, msg.teams ? this.myTeam() : this.me);
        $("#mpRanking").prop("hidden", false);

        app.INPUT_GUESS.prop("hidden", true);
        app.BUTTON_GUESS.prop("hidden", true);
        this.renderStatus();
    }

    /**
     * Fit the solution and every submitted guess into view (the own guess alone is not enough, and a watcher has none)
     */
    focusReveal(solution, results) {
        const mm = this.app.minimap;
        const points = [solution, ...results.filter(r => r.lat !== null).map(r => this.toMap(r))];
        if (points.length === 1) {
            mm.flyTo(solution, this.app.selectedMode === "mapFinder" ? 3 : 6, { duration: 1.5 });
            return;
        }
        // room for the name tags above the markers: on top, and to the sides for half the widest tag (a 20-character
        // name + "+100" is about 190px), on the left also for the zoom buttons. On small (phone) maps each side gets
        // at most a share of the map, so the guesses still get most of it
        const size = mm.getSize();
        const pad = (px, share, length) => Math.min(px, Math.round(share * length));
        mm.flyToBounds(new LatLngBounds(points), {
            paddingTopLeft: [pad(150, 0.2, size.x), pad(110, 0.3, size.y)],
            paddingBottomRight: [pad(100, 0.15, size.x), pad(40, 0.1, size.y)],
            maxZoom: 6,
            duration: 1.5,
        });
    }

    toMap({ lat, lng }) {
        const mm = this.app.minimap;
        return [lat * mm.gameToMapScale, lng * mm.gameToMapScale];
    }

    addPlayerMarker(result, options = {}) {
        const mm = this.app.minimap;
        const label = document.createElement("span");
        label.textContent = `${result.name} ${formatPoints(result.points)}`;
        // team play: the team's color in front of the name
        if (result.team !== undefined) label.prepend(teamDot(result.team)[0]);
        return new guessMarker(this.toMap(result), { draggable: false, ...options }, mm)
            .addTo(mm.markersGroup)
            .bindTooltip(label, { permanent: true, direction: "top", offset: [0, -45], className: "mpTooltip" });
    }

    /**
     * The host moves everyone on to the final screen (with settings.next the countdown does); anyone else just goes
     * there on their own: the last reveal already holds the final scores, sorted
     */
    showResults() {
        if (this.isHost() && !this.state.settings.next) return this.next();
        this.finalFromReveal();
    }

    finalFromReveal() {
        const { results, teams } = this.lastReveal;
        // team play ranks the teams, with who played in them
        const ranking = teams
            ? teams.map(t => ({ id: t.id, score: t.score, members: this.state.players.filter(p => p.team === t.id).map(p => p.name) }))
            : results.map(r => ({ id: r.id, name: r.name, score: r.score }));
        const top = ranking[0]?.score;
        this.onFinal({ ranking, winners: ranking.filter(r => r.score === top).map(r => r.id) });
    }

    onFinal(msg) {
        clearInterval(this.countdown);
        // no prepare follows the last round, so its preloaded images (and their retries) would outlive the game
        this.preloader.keep([]);
        // from the ranking itself, not the state: an old game's link (onEnded) shows its results without one
        const teamPlay = msg.ranking.some(r => r.members);
        const rows = teamPlay ? msg.ranking.map(r => ({ ...r, team: r.id, name: teamName(r.id) })) : msg.ranking;
        const mine = teamPlay ? this.myTeam() : this.me;
        this.renderRanking($("#mpFinalRanking"), rows, msg.winners, {}, mine);
        const me = rows.find(r => r.id === mine);
        $("#scoreValue").text(me ? me.score : rows[0]?.score ?? 0);
        this.app.switchUI("results");
    }

    /**
     * A game that is over (an old link, or one past its last round): its results, and nothing more to do in it
     */
    onEnded(msg) {
        // a stored token stays: once the next game is over too, this old link leads its player into the lobby after it
        this.onFinal(msg);
        this.stop();
        $("body").addClass("mp-ended");
    }

    renderPlayers(s) {

        const chip = p => $("<li>")
            .text([`${p.id === s.hostId ? "👑 " : ""}${s.settings.team === "leader" && p.leader ? "⭐ " : ""}${p.name}${this.doneMark(s, p) ? " ✓" : ""}`, this.loadMark(s, p), s.phase === "lobby" && p.back === false ? "⏳" : ""].filter(Boolean).join(" "))
            .toggleClass("offline", !p.connected)
            // Leader: the leader's name in gold like the star, so the team sees at once who leads it
            .toggleClass("leader", s.settings.team === "leader" && p.leader)
            .attr("title", s.phase === "lobby" && p.back === false ? i18next.t("mp.onResults", { ns: "common" }) : null)
            .toggleClass("ready", s.phase === "lobby" && this.doneMark(s, p))
            .toggleClass("me", p.id === this.me);
        const teamPlay = Boolean(s.settings.team);
        // in-game chips: team play shows each player's team in front of the name
        $("#mpChips").empty().append(s.players.map(p => chip(p).prepend(teamPlay ? teamDot(p.team) : null)));
        // kicking is lobby only, so the in-game chips stay without the button
        const kickable = s.phase === "lobby" && this.isHost();
        // Leader: in the lobby a leader may hand the role to a teammate who is there
        const me = s.players.find(p => p.id === this.me);
        const leadable = p => s.phase === "lobby" && s.settings.team === "leader" && me?.leader && p.team === me.team && p.id !== this.me && p.connected;
        const item = p => {
            const $li = chip(p);
            const button = (action, icon, key) => {
                // set as an attribute, not HTML: the name must not come out escaped
                const label = i18next.t(key, { ns: "common", name: p.name, interpolation: { escapeValue: false } });
                return $(`<button class="mp-${action}">`).text(icon).attr({ "data-id": p.id, "data-action": action, "aria-label": label, title: label });
            };
            if (leadable(p)) $li.append(button("lead", "🎖️", "mp.makeLeader"));
            if (!kickable || p.id === this.me) return $li;
            // only to someone who is there: the role would move on again at once (see fixHost on the server)
            if (p.connected && p.back !== false) $li.append(button("promote", "🔑", "mp.makeHost"));
            return $li.append(button("kick", "✕", "mp.kick"));
        };
        // team play: a block per team instead of the one list
        if (teamPlay) this.teams.renderLobby(s, item);
        else $("#mpPlayers").empty().append(s.players.map(item));
        $("#mpPlayers").prop("hidden", teamPlay);
        $("#mpTeamList").prop("hidden", !teamPlay);
        // the reveal ranking hides the chips (lobby.scss), so while the next round loads it carries the marks itself
        $("#mpRanking li").each((_, li) => {
            const p = s.players.find(x => x.id === li.dataset.id);
            // in front of the name: the ranking cuts long names off with an ellipsis, which would hide a mark behind them
            if (p) $(li).find(".name").text([this.loadMark(s, p), p.name].filter(Boolean).join(" "));
        });
    }

    /**
     * ✓ for whoever answered the running round, and in the lobby for a guest who is ready (the host never needs to be)
     */
    doneMark(s, p) {
        if (s.phase === "round") return p.answered;
        return s.phase === "lobby" && p.lobbyReady && p.id !== s.hostId;
    }

    /**
     * While everyone waits for the images: ⏳ still loading, 💤 missed the last loading time and is not waited for
     */
    loadMark(s, p) {
        if (s.phase !== "loading" || !p.connected) return "";
        if (p.stalled) return "💤";
        return p.ready ? "" : "⏳";
    }

    renderRanking($list, rows, winners = [], moves = {}, mine = this.me) {
        $list.empty();
        rows.forEach((row, i) => {
            const move = moves[row.id];
            // always there, empty without a move: the columns of every ranking line up
            const $move = $("<span class=\"move\">");
            if (move) $move.addClass(move).attr({ role: "img", "aria-label": i18next.t(`mp.${move}`, { ns: "common" }) });
            $("<li>")
                .attr("data-id", row.id)
                .toggleClass("me", row.id === mine)
                .append(
                    $("<span class=\"rank\">").text(winners.includes(row.id) ? "🏆" : `${i + 1}.`),
                    $move,
                    // team play: the team's color in front of its name
                    $("<span class=\"name\">").text(row.name).prepend(row.team === undefined ? null : teamDot(row.team)),
                    $("<span class=\"points\">").text(row.points === undefined ? "" : formatPoints(row.points)).toggleClass("negative", row.points < 0),
                    $("<span class=\"score\">").text(row.score),
                    // team play's final: who played in the team
                    row.members ? $("<span class=\"members\">").text(row.members.join(", ")) : null
                )
                .appendTo($list);
        });
    }

    // ===== CHAT =====

    onChat(line) {
        this.addChatLine(line);
        // someone coming or going is no reason to open the chat
        if (!line.system && line.id !== this.me && !this.chatOpen) this.unread++;
        this.renderChat();
    }

    addChatLine({ id, name, text, system }) {
        const log = document.getElementById("mpChatLog");
        // as text, never HTML: names and lines come from other players. Each with its own direction (dir isolates it):
        // a right-to-left name must not pull the line's start in front of it and so fake who wrote what
        if (system) {
            // someone came into, left or was kicked from the lobby: one quiet sentence, the name isolated inside it (FSI … PDI).
            // Unescaped, .text() keeps it from being HTML
            const notice = i18next.t(`mp.${system}`, { ns: "common", name: `\u2068${name}\u2069`, interpolation: { escapeValue: false } });
            $("<li class=\"notice\">").text(notice).appendTo(log);
        } else {
            $("<li>")
                .toggleClass("me", id === this.me)
                .append($("<strong dir=\"auto\">").text(name), $("<span dir=\"auto\">").text(text))
                .appendTo(log);
        }
        $(log).children().slice(0, -CHAT_HISTORY).remove();
        // follows new lines only from the bottom: whoever scrolled up to read stays there, unless they write themselves
        if (this.chatPinned || id === this.me) log.scrollTop = log.scrollHeight;
    }

    /**
     * The chat is for players: in the lobby, between rounds, and in a round once their answer is in (the server sends
     * nobody who still guesses a line of it); never on the big screen
     */
    renderChat() {
        const me = this.state?.players.find(p => p.id === this.me);
        const shown = Boolean(me) && !this.watching && (this.state.phase !== "round" || me.answered);
        // small screens: left open, the chat would cover the map, so a round closes it until the answer is in (and the
        // reveal again, see onReveal; only for now: the remembered choice still opens it in the next lobby after a reload)
        if (!shown && this.state?.phase === "round" && matchMedia(SMALL_SCREEN).matches) this.chatOpen = false;
        const wasVisible = $("#mpChatPanel").is(":visible");
        const docked = $("body").hasClass("mp-chat-open");
        $("body").toggleClass("mp-chat", shown).toggleClass("mp-chat-open", shown && this.chatOpen);
        // docked on wide screens, the chat takes its room from the game (also when it opens with the answer): the map
        // has to learn its new size
        if (docked !== $("body").hasClass("mp-chat-open") && $("#map_ui").is(":visible")) this.app.minimap.invalidateSize();
        $("#mpChatPanel").prop("hidden", !this.chatOpen);
        $("#BUTTON_MP_CHAT").attr("aria-expanded", String(this.chatOpen));
        $("#mpChatUnread").text(this.unread > 9 ? "9+" : this.unread).prop("hidden", this.unread === 0);
        // a hidden log has no height to scroll: once it shows (opened, after a reload, after a round) it starts at the newest line
        const log = document.getElementById("mpChatLog");
        if (!wasVisible && $("#mpChatPanel").is(":visible")) log.scrollTop = log.scrollHeight;
    }

    toggleChat(open) {
        this.chatOpen = open;
        localStorage.setItem("mp:chatOpen", open ? "1" : "0");
        if (open) this.unread = 0;
        // the keyboard focus goes back to the button instead of getting lost in the closed panel
        if (!open && document.getElementById("mpChatPanel").contains(document.activeElement)) $("#BUTTON_MP_CHAT").trigger("focus");
        this.renderChat();
        // touch screens would pull up their keyboard over half the screen just for reading
        if (open && matchMedia("(pointer: fine)").matches) $("#mpChatInput").trigger("focus");
    }

    describeSettings({ mode, timer, rounds, next, keepCode, team, teams, penalty, decide }) {
        const t = (key, options) => i18next.t(key, { ns: "common", ...options });
        const modeLabel = mode === "classic" ? t("menu.classic") : t("menu.findMap");
        const timerLabel = { 0: t("timer.chill"), 60: t("timer.timedOption") }[timer] ?? `${t("timer.rush")} ${timer}\u00a0s`;
        // a no-break space keeps "10 s" together when the summary wraps
        const nextLabel = next ? ` · ${t("mp.settings.next")}: ${t("mp.nextAuto")} ${next}\u00a0s` : "";
        const codeLabel = keepCode ? ` · ${t("mp.code")}: ${t("mp.codeKeep")}` : "";
        const penaltyLabel = team === "sum" && penalty ? ` · ${t("mp.settings.penalty")}` : "";
        const decideLabel = team === "leader" ? ` · ${t("mp.settings.decide")} ${decide}\u00a0s` : "";
        const teamLabel = team ? ` · ${t(`mp.teamModes.${team}`)} · ${t("mp.teamCount", { n: teams })}${penaltyLabel}${decideLabel}` : "";
        return `${modeLabel} · ${timerLabel} · ${rounds} ${t("mp.rounds")}${nextLabel}${codeLabel}${teamLabel}`;
    }

    showEntry() {
        $("#mpEntry").prop("hidden", false);
        $("#mpRoom").prop("hidden", true);
        this.app.switchUI("lobby");
    }

    showRoom() {
        clearInterval(this.countdown);
        $("#mpEntry").prop("hidden", true);
        $("#mpRoom").prop("hidden", false);
        this.drawQr();
        if (!$("#lobby").is(":visible")) this.app.switchUI("lobby");
    }

    drawQr() {
        if (this.qrCode === this.code) return;
        this.qrCode = this.code;
        const url = `${location.origin}/?join=${this.code}`;
        QRCode.toCanvas(document.getElementById("mpQr"), url, { width: 220, margin: 1 });
        const watchUrl = `${location.origin}/?watch=${this.code}`;
        $("#mpJoinUrl").attr("href", url).text(url);
        $("#mpWatchUrl").attr("href", watchUrl).text(watchUrl);
    }

    copyLink(selector, key) {
        copyText($(selector).text())
            .then(() => this.toast("success", key))
            .catch(err => console.error("Copy failed", err));
    }

    toast(type, key, options = {}, subKey = null) {
        // openToast sets innerHTML: values (a player name is user input) go through i18next, which escapes them
        this.app.openToast(type, i18next.t(key, { ns: "common", ...options }), subKey ? i18next.t(subKey, { ns: "common" }) : "");
    }
}
