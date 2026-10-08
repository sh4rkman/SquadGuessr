import i18next from "i18next";
import { LatLngBounds } from "leaflet";
import QRCode from "qrcode";
import { guessMarker } from "./guessMarker.js";
import { updateOffset } from "./clock.js";
import { copyText } from "./clipboard.js";
import Preloader from "./preloader.js";
import { findMap, basemapUrl } from "./data/maps.js";

const RETRY_DELAYS = [1000, 2000, 5000];
// NEXT / RESULTS stay locked until the server answers, or at most this long (e.g. the connection just dropped)
const NEXT_UNLOCK_MS = 5000;

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
        $("#BUTTON_MP_LEAVE").on("click", () => this.leave());
        $("#BUTTON_MP_START").on("click", () => this.start());
        $("#BUTTON_MP_WATCH").on("click", () => this.watchCode($("#mpCode").val()));
        $("#BUTTON_MP_ENDROUND").on("click", () => this.send({ type: "endRound" }));
        $("#BUTTON_MP_COPY_JOIN").on("click", () => this.copyLink("#mpJoinUrl", "mp.joinLinkCopied"));
        $("#BUTTON_MP_COPY_WATCH").on("click", () => this.copyLink("#mpWatchUrl", "mp.watchLinkCopied"));
        $("#mpSettings select").on("change", () => this.send({ type: "settings", settings: this.readSettings() }));
        $("#mpPlayers").on("click", ".mp-kick", (e) => this.send({ type: "kick", playerId: e.currentTarget.dataset.id }));
        document.addEventListener("visibilitychange", () => this.onVisible());

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
        return {
            mode: $("#mpMode").val(),
            timer: Number($("#mpTimer").val()),
            rounds: Number($("#mpRounds").val()),
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
                this.app.setButtonLoading($("#BUTTON_MP_START"), false);
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
        // a JOIN clicked while a watch attempt still connects makes this a player again
        this.watching = hello.type === "watch";
        this.active = true;
        this.retry = 0;
        $("body").addClass("mp-active");
        this.connect();
    }

    connect() {
        const protocol = location.protocol === "https:" ? "wss" : "ws";
        const ws = new WebSocket(`${protocol}://${location.host}/mp`);
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
        this.roundIndex = null;
        this.revealIndex = null;
        // the game screen is gone: a round seen again later (watching this session after leaving it) must count as fresh
        this.app.currentGuess = null;
        this.app.selectMode($(".mode-card.selected").data("mode") || "classic");
        const ws = this.ws;
        this.ws = null;
        ws?.close();
        this.state = null;
        this.me = null;
        this.code = null;
        $("body").removeClass("mp-active mp-host watch-mode mp-reveal");
        $("#mpBanner, #mpStatus, #mpRanking, #BUTTON_MP_ENDROUND").prop("hidden", true);
        this.app.INPUT_GUESS.prop("disabled", false);
    }

    leave() {
        this.send({ type: "leave" });
        // a big-screen tab never held a player token: it must not drop the one the player tab next to it uses
        if (this.code && !this.watching) localStorage.removeItem(`mp:${this.code}`);
        this.stop();
        this.app.toMenu();
    }

    // ===== MESSAGES =====

    onMessage(msg) {
        if (msg.serverNow) this.offset = updateOffset(this.offset, msg.serverNow, Date.now());

        switch (msg.type) {
        case "welcome":
            this.me = msg.playerId;
            this.code = msg.code;
            localStorage.setItem(`mp:${msg.code}`, msg.token);
            this.hello = { type: "join", code: msg.code, name: this.hello.name, token: msg.token };
            history.replaceState({}, "", `/?join=${msg.code}`);
            break;
        case "state":
            // like welcome for a player: only once the server took the code does the page turn into the big screen and
            // the address into its link (a reload keeps watching); until then the entry form, BACK included, stays usable
            if (this.watching && !this.state) {
                $("body").addClass("watch-mode");
                history.replaceState({}, "", `/?watch=${msg.code}`);
            }
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
        case "error":
            this.onError(msg.code);
            break;
        }
    }

    onError(code) {
        // a rejected start brings no new state, so the START spinner would stay
        if (this.state?.phase === "lobby" && !this.guessFetch) this.app.setButtonLoading($("#BUTTON_MP_START"), false);
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
        this.toast("error", `mp.errors.${code}`);
        // a stored token that did not get us back in (dead session, or it expired and the name is taken now) is useless
        if (code === "SESSION_NOT_FOUND" || code === "NAME_TAKEN") localStorage.removeItem(`mp:${this.hello?.code}`);
        const rejected = ["SESSION_NOT_FOUND", "NAME_TAKEN", "SESSION_FULL", "SERVER_BUSY", "KICKED"].includes(code);
        if (!rejected) return;
        // back to the menu: were in the session (server restart, dropped from the lobby), a big-screen link, or an invite
        // link whose form cannot fix it (dead or full session; the form only lets you change the name)
        const invite = $("#mpEntry").hasClass("invite");
        const watchLink = Boolean(new URLSearchParams(location.search).get("watch"));
        if (this.state || watchLink || (invite && code !== "NAME_TAKEN")) return this.leave();
        // wrong code (to play or to watch) or taken name: stay on the form to correct it
        // (an automatic rejoin after a reload never showed the form, hence showEntry)
        this.stop();
        this.showEntry();
    }

    // ===== RENDERING =====

    isHost() {
        return this.me !== null && this.state?.hostId === this.me;
    }

    renderState() {
        const s = this.state;
        this.code = s.code;
        $("body").toggleClass("mp-host", this.isHost());
        $("#mpRoomCode").text(s.code);
        $("#mpMode").val(s.settings.mode);
        $("#mpTimer").val(String(s.settings.timer));
        $("#mpRounds").val(String(s.settings.rounds));
        $("#mpSettingsSummary").text(this.describeSettings(s.settings));
        this.renderPlayers(s);

        const me = s.players.find(p => p.id === this.me);
        if (me) $("#totalPoints").text(me.score);

        this.renderStatus();
        if (s.phase === "lobby") this.showRoom();
        // a page that (re)opened while everyone waits for the images: the room shows who is loading, not the menu
        if (s.phase === "loading" && !$("#map_ui").is(":visible")) this.showRoom();
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
        $("#BUTTON_MP_ENDROUND").prop("hidden", s.phase !== "round" || !host || s.settings.timer > 0);
        // any answer from the server unlocks NEXT / RESULTS (see next())
        clearTimeout(this.nextTimer);
        this.app.BUTTON_NEXT.prop({ hidden: s.phase !== "reveal" || !host || last, disabled: false });
        // after the last round every player may look at the results; the big screen follows the host
        this.app.BUTTON_RESULTS.prop({ hidden: s.phase !== "reveal" || !last || this.watching, disabled: false });
        // the lobby stays on screen while the first round loads: the start went through, the settings are fixed
        this.app.setButtonLoading($("#BUTTON_MP_START"), loading || Boolean(this.guessFetch));
        $("#mpSettings select").prop("disabled", s.phase !== "lobby");
        $("#mpWaitingForHost").prop("hidden", loading);
        $("#mpLobbyStatus").prop("hidden", !loading);
        if (loading) {
            const waited = s.players.filter(p => p.connected && !p.stalled);
            const text = i18next.t("mp.loadingImages", {
                ns: "common",
                ready: waited.filter(p => p.ready).length,
                total: waited.length,
            });
            $("#mpStatus, #mpLobbyStatus").text(text);
            $("#mpStatus").prop("hidden", false);
            return;
        }
        if (s.phase === "reveal") {
            $("#mpStatus").text(i18next.t("mp.waitingForHost", { ns: "common" })).prop("hidden", host || (last && !this.watching));
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
        app.BUTTON_GUESS.prop({ hidden: this.watching || this.answered, disabled: !unsent });

        app.switchUI("game");
        app.minimap.invalidateSize();
        if (!resent) this.visible = Promise.all([mapShown, app.setupHint()]);
        this.renderStatus();
        this.startCountdown(msg.deadline);
    }

    submitAnswer() {
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
            const left = Math.max(0, Math.ceil((deadline - Date.now() - (this.offset ?? 0)) / 1000));
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

        clearInterval(this.countdown);
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
        msg.results
            .filter(r => r.lat !== null && r.id !== this.me)
            .forEach(r => {
                this.addPlayerMarker(r);
                app.drawSolutionDistance(latLng, this.toMap(r), othersStyle);
            });
        if (mine && mine.lat !== null) {
            const you = { ...mine, name: i18next.t("mp.you", { ns: "common" }) };
            mm.guessMarker = this.addPlayerMarker(you, { iconClass: "mp-own", zIndexOffset: 1000 });
            app.drawSolutionDistance(latLng);
        }
        this.focusReveal(latLng, msg.results);

        if (mine) {
            $("#dist").text(mine.distance === null ? "—" : app.formatDistance(mine.distance));
            $("#points").text(mine.points);
            $("#text").css("visibility", "visible");
        }
        const mapLabel = solution.map.charAt(0).toUpperCase() + solution.map.slice(1);
        if (app.selectedMode === "mapFinder") {
            $("#mapName").text(`${mine ? (mine.points ? "✅ " : "❌ ") : ""}${mapLabel}`).fadeIn();
        } else if (mine) {
            $("#mapName").text(`${mine.points} ${i18next.t("shared.points", { ns: "common" })}`).fadeIn();
        }

        this.renderRanking($("#mpRanking"), msg.results);
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
        label.textContent = `${result.name} +${result.points}`;
        return new guessMarker(this.toMap(result), { draggable: false, ...options }, mm)
            .addTo(mm.markersGroup)
            .bindTooltip(label, { permanent: true, direction: "top", offset: [0, -45], className: "mpTooltip" });
    }

    /**
     * The host moves everyone on to the final screen; anyone else just goes there on their own:
     * the last reveal already holds the final scores, sorted
     */
    showResults() {
        if (this.isHost()) return this.next();
        const ranking = this.lastReveal.results.map(r => ({ id: r.id, name: r.name, score: r.score }));
        const top = ranking[0]?.score;
        this.onFinal({ ranking, winners: ranking.filter(r => r.score === top).map(r => r.id) });
    }

    onFinal(msg) {
        clearInterval(this.countdown);
        // no prepare follows the last round, so its preloaded images (and their retries) would outlive the game
        this.preloader.keep([]);
        this.renderRanking($("#mpFinalRanking"), msg.ranking, msg.winners);
        const me = msg.ranking.find(r => r.id === this.me);
        $("#scoreValue").text(me ? me.score : msg.ranking[0]?.score ?? 0);
        this.app.switchUI("results");
    }

    renderPlayers(s) {

        const chip = p => $("<li>")
            .text(`${p.id === s.hostId ? "👑 " : ""}${p.name}${s.phase === "round" && p.answered ? " ✓" : ""}`)
            .toggleClass("offline", !p.connected)
            .toggleClass("me", p.id === this.me);
        $("#mpChips").empty().append(s.players.map(chip));
        // kicking is lobby only, so the in-game chips stay without the button
        const kickable = s.phase === "lobby" && this.isHost();
        $("#mpPlayers").empty().append(s.players.map(p => {
            const $li = chip(p);
            if (!kickable || p.id === this.me) return $li;
            // set as an attribute, not HTML: the name must not come out escaped
            const label = i18next.t("mp.kick", { ns: "common", name: p.name, interpolation: { escapeValue: false } });
            return $li.append($("<button class=\"mp-kick\">✕</button>").attr({ "data-id": p.id, "aria-label": label, title: label }));
        }));

        const items = s.players.map(p => $("<li>")
            .text([`${p.id === s.hostId ? "👑 " : ""}${p.name}${s.phase === "round" && p.answered ? " ✓" : ""}`, this.loadMark(s, p)].filter(Boolean).join(" "))
            .toggleClass("offline", !p.connected)
            .toggleClass("me", p.id === this.me));
        $("#mpPlayers").empty().append(items);
        $("#mpChips").empty().append(items.map($li => $li.clone()));
        // the reveal ranking hides the chips (lobby.scss), so while the next round loads it carries the marks itself
        $("#mpRanking li").each((_, li) => {
            const p = s.players.find(x => x.id === li.dataset.id);
            // in front of the name: the ranking cuts long names off with an ellipsis, which would hide a mark behind them
            if (p) $(li).find(".name").text([this.loadMark(s, p), p.name].filter(Boolean).join(" "));
        });
    }

    /**
     * While everyone waits for the images: ⏳ still loading, 💤 missed the last loading time and is not waited for
     */
    loadMark(s, p) {
        if (s.phase !== "loading" || !p.connected) return "";
        if (p.stalled) return "💤";
        return p.ready ? "" : "⏳";
    }

    renderRanking($list, rows, winners = []) {
        $list.empty();
        rows.forEach((row, i) => {
            $("<li>")
                .attr("data-id", row.id)
                .toggleClass("me", row.id === this.me)
                .append(
                    $("<span class=\"rank\">").text(winners.includes(row.id) ? "🏆" : `${i + 1}.`),
                    $("<span class=\"name\">").text(row.name),
                    $("<span class=\"points\">").text(row.points === undefined ? "" : `+${row.points}`),
                    $("<span class=\"score\">").text(row.score)
                )
                .appendTo($list);
        });
    }

    describeSettings({ mode, timer, rounds }) {
        const t = (key) => i18next.t(key, { ns: "common" });
        const modeLabel = mode === "classic" ? t("menu.classic") : t("menu.findMap");
        const timerLabel = { 0: t("timer.chill"), 60: t("timer.timed"), 15: t("timer.rush") }[timer];
        return `${modeLabel} · ${timerLabel} · ${rounds} ${t("mp.rounds")}`;
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
        $("#mpJoinUrl").text(url);
        $("#mpWatchUrl").text(`${location.origin}/?watch=${this.code}`);
    }

    copyLink(selector, key) {
        copyText($(selector).text())
            .then(() => this.toast("success", key))
            .catch(err => console.error("Copy failed", err));
    }

    toast(type, key) {
        this.app.openToast(type, i18next.t(key, { ns: "common" }), "");
    }
}
