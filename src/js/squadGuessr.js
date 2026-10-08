import { MAPS, initMapsProperties, findMap } from "./data/maps.js";
import { squadMinimap } from "./squadMinimap.js";
import { loadLanguage } from "../i18n/i18n.js";
import { Polyline, LatLngBounds } from "leaflet";
import SquadSettings from "./squadSettings.js";
import packageInfo from "../../package.json";
import i18next from "i18next";
import { solutionMarker } from "./guessMarker.js";
import { pointsForDistance, scoreAnswer, distance } from "./scoring.js";
import Multiplayer from "./multiplayer.js";
import { copyText } from "./clipboard.js";
import { retryDelay } from "./preloader.js";
import "./libs/leaflet-measure-path.js";

/**
 * Main class for SquadCalc
 * @classdesc Holds all the main functions
 */
export default class SquadGuessr {
    constructor(options) {
        this.supportedLanguages = options.supportedLanguages;
        this.MAPSIZE = options.mapSize;
        this.userSettings = new SquadSettings(this);
        this.activeWeapon = "";
        this.hasMouse = matchMedia("(pointer:fine)").matches;
        this.version = packageInfo.version;

        // Initialize DOM references
        this.initializeElements();

        window.debugChangeMap = this.debugChangeMap.bind(this);

        // Initialize game state
        this.selectedMode = null;
        this.score = 0;
        this.gamePhase = 0;
        this.gameData = null;
        this.currentGuess = null;
        this.timerInterval = null;
        this.session = false;
        this.mp = new Multiplayer(this);
    }

    initializeElements() {
        this.BUTTON_TIMER = $("#BUTTON_TIMER");
        this.BUTTON_NEXT = $("#BUTTON_NEXT");
        this.BUTTON_GUESS = $("#BUTTON_GUESS");
        this.BUTTON_NEWGAME = $("#BUTTON_PLAY");
        this.BUTTON_RESULTS = $("#BUTTON_RESULTS");
        this.BUTTON_PLAYAGAIN = $("#BUTTON_PLAYAGAIN");
        this.BUTTON_MENU = $("#BUTTON_MENU");
        this.BUTTON_BACK = $("#BUTTON_BACK");
        this.BUTTON_SHARE = $("#BUTTON_SHARE");
        this.MAIN_LOGO = $("#MAINLOGO");
        this.INPUT_GUESS = $("#searchMap");
    }

    // ===== INITIALIZATION =====

    init() {
        this.initializeCore();
        this.setupEventListeners();
        console.log(`SquadGuessr v${this.version} Loaded!`);
        this.switchUI("menu");
        this.mp.init();
    }

    initializeCore() {
        loadLanguage(this.supportedLanguages);
        initMapsProperties();
        this.loadTopScores();
        this.userSettings.init();
        this.loadMinimap();
        this.loadUI();
        //this.updateContent();
        this.selectMode("classic");
        this.selectTimer("0");
    }

    setupEventListeners() {
        this.setupModeSelection();
        this.setupTimerSelection();
        this.setupGameButtons();
        this.setupNavigationButtons();
        this.setupImageOverlay();
        this.setupGuessInput();
        this.setupShortkeys();
    }


    setupShortkeys(){
        document.addEventListener("keydown", (e) => {
            // Only react to Space
            if (e.code !== "Space") return;

            // Ignore when typing in inputs / textareas / contenteditable
            const tag = e.target.tagName;
            if (tag === "INPUT" || tag === "TEXTAREA" || e.target.isContentEditable) return;

            e.preventDefault();

            if (this.BUTTON_GUESS.is(":visible") && !this.BUTTON_GUESS.prop("disabled")) {
                this.BUTTON_GUESS.trigger("click");
                return;
            }

            if (this.BUTTON_NEXT.is(":visible") && !this.BUTTON_NEXT.prop("disabled")) {
                this.BUTTON_NEXT.trigger("click");
                return;
            }

            if (this.BUTTON_RESULTS.is(":visible") && !this.BUTTON_RESULTS.prop("disabled")) {
                this.BUTTON_RESULTS.trigger("click");
                return;
            }
            
        });
    
    }

    setupModeSelection() {
        document.querySelectorAll(".mode-card").forEach(card => {
            card.addEventListener("click", () => {
                const mode = card.getAttribute("data-mode");
                this.selectMode(mode);
            });
        });
    }

    setupTimerSelection() {
        document.querySelectorAll(".timer-card").forEach(card => {
            card.addEventListener("click", () => {
                const timer = card.getAttribute("data-timer");
                this.selectTimer(timer);
            });
        });
    }

    setupGameButtons() {

        this.BUTTON_NEWGAME.on("click", () => this.startNewGame());
        this.BUTTON_GUESS.on("click", () => this.handleGuess());
        this.BUTTON_NEXT.on("click", () => this.mp.active ? this.mp.next() : this.loadNextGuess());
        this.BUTTON_RESULTS.on("click", () => this.mp.active ? this.mp.showResults() : this.showResults());

    }

    setupNavigationButtons() {
        this.BUTTON_TIMER.on("click", () => { this.switchUI("timer"); });
        this.BUTTON_MENU.on("click", () => { this.mp.active ? this.mp.leave() : this.switchUI("menu"); });
        this.BUTTON_BACK.on("click", () => { this.switchUI("menu"); });
        this.BUTTON_PLAYAGAIN.on("click", () => this.mp.active ? this.mp.send({ type: "lobby" }) : this.startNewGame());
        this.BUTTON_SHARE.on("click", () => this.copyResults());
        this.MAIN_LOGO.on("click", () => {
            this.stopTimer();
            if (this.mp.active) return this.mp.leave();
            this.switchUI("menu");
        });
    }


    copyResults() {
        let text = `\u200B\n\u200B\n🏆 I just scored **${this.score} points** in SquadGuessr! 🏆\n`;

        this.gameData.forEach((guess, index) => { text += `  🔸*Guess#${index + 1}: ${guess.points} points*\n`; });
        text = text + "\nThink you can beat me? Try now: https://squadguessr.app 🗺️";

        copyText(text).then(() => {
            let title = i18next.t("common:results.resultCopied");
            let subtext = i18next.t("common:results.shareItWithYourFriends");
            this.openToast("success", title, subtext);
        }).catch(err => {
            console.error("Copy failed", err);
        });

    }


    setupImageOverlay() {
        const icon = document.querySelector(".preview-icon");
        const hint = document.getElementById("hint");
        const overlay = document.getElementById("imageOverlay");
        const overlayImg = document.getElementById("overlayImage");

        const showOverlay = () => {
            overlayImg.src = hint.src;
            overlay.classList.remove("hidden");
        };

        const hideOverlay = () => overlay.classList.add("hidden");

        icon?.addEventListener("click", showOverlay);
        hint?.addEventListener("click", showOverlay);
        overlay?.addEventListener("click", hideOverlay);

        document.addEventListener("keydown", (e) => {
            if (e.key === "Escape") hideOverlay();
        });
    }

    setupGuessInput() {
        // Enable/disable guess button based on input text
        this.INPUT_GUESS.on("input", () => {
            const hasText = this.INPUT_GUESS.val().trim() !== "";
            this.BUTTON_GUESS.prop("disabled", !hasText);
        });

        // Handle Enter key to submit
        this.INPUT_GUESS.on("keypress", (e) => {
            if (e.key === "Enter" && !this.BUTTON_GUESS.prop("disabled")) {
                this.BUTTON_GUESS.trigger("click");
            }
        });
    }

    // ===== GAME FLOW =====
    startNewGame(ROUND_NUMBER = 5) {
        this.setButtonLoading(this.BUTTON_NEWGAME, true);
        this.setButtonLoading(this.BUTTON_PLAYAGAIN, true);

        this.getGuess(ROUND_NUMBER)
            .catch(error => {
                this.setButtonLoading(this.BUTTON_NEWGAME, false);
                this.setButtonLoading(this.BUTTON_PLAYAGAIN, false);
                if (error.name !== "AbortError") throw error;
            })
            .then(response => {
                if (!response) return;
                this.initializeGameState(response);
                this.loadNextGuess();
                this.switchUI("game");
            })
            .finally(() => {
                this.setButtonLoading(this.BUTTON_NEWGAME, false);
                this.setButtonLoading(this.BUTTON_PLAYAGAIN, false);
            });
    }

    initializeGameState(gameData) {
        this.gameData = gameData;
        this.gamePhase = 0;
        this.score = 0;

        $("#totalPoints").html(0);
        // a previous game (or a multiplayer round) may have hidden or disabled the map name input
        this.INPUT_GUESS.val("").prop({ hidden: false, disabled: false });

        this.BUTTON_NEXT.prop("hidden", false);
        this.BUTTON_GUESS.prop("hidden", false);
        this.BUTTON_RESULTS.prop("hidden", true);
    }


    /**
     * Fetches guess data from the API
     * @param {number} number - The number of guesses to fetch (1-10).
     * @returns {Promise<Array>} A promise that resolves with the decoded guess data.
     * @throws {Error} Throws an error if the network request fails or the response is not OK.
     */
    async getGuess(number) {
        const url = `/api/v2/get/squadGuess?nb=${number}`;
        try {
            const response = await fetch(url, {
                headers: { "X-App-Version": this.version }
            });

            if (!response.ok) {
                throw new Error("Network response was not ok");
            }

            const result = await response.json();

            // Decode the base64 data
            const decodedString = atob(result.data);
            const data = JSON.parse(decodedString);
            console.debug("Guesses data fetched successfully:", data);
            return data;
        } catch (error) {
            console.debug("Error fetching guesses data, is API down ?");
            throw error;
        }
    }

    
    loadNextGuess() {
        $("#text").css("visibility", "hidden");

        this.currentGuess = this.gameData[this.gamePhase];
        this.INPUT_GUESS.val("");
        $("#mapName").hide();
        this.solutionMarker = null;

        this.setupMap();

        this.updateRoundDisplay();
        this.disableButtons();
        this.gamePhase++;

        if (this.selectedMode === "mapFinder") {
            $("#gameWrapper").addClass("no-map");
        } else {
            $("#gameWrapper").removeClass("no-map");
        }

        this.setupHint().then(() => {
            if (this.selectedTimer > 0) this.startTimeAttackTimer(this.selectedTimer);
        });

    }

    debugChangeMap(mapName) {
        const map = findMap(mapName);
        if (!map) {
            console.debug(`Map "${mapName}" not found ❌`);
            console.debug("Available maps:");
            MAPS.forEach(m => console.log(`  - ${m.name}`));
            return;
        }
        this.minimap.clear();
        this.minimap.activeMap = map;
        this.minimap.draw(true);
        console.debug(`Map changed to: ${map.name} ✅`);
        console.debug("Click anywhere on the map to log the latlng");
    }

    setupMap() {
        const map = findMap(this.currentGuess.map);
        this.minimap.clear();
        this.minimap.activeMap = map;
        return this.minimap.draw(true);
    }

    /**
     * The hint image's URL; the multiplayer preloads exactly this one
     */
    hintUrl(url) {
        return `/api/v2${url}`;
    }

    /**
     * Shows the current guess's hint image; resolves after the first attempt (loaded or failed), so a timer waiting
     * for it always starts. A failed image is retried (see retryDelay) while this guess is still on the game screen
     */
    setupHint() {
        const $hint = $("#hint");
        const $wrapper = $("#hint-wrapper");
        const guess = this.currentGuess;
        const url = this.hintUrl(guess.url);
        let failures = 0;

        clearTimeout(this.hintRetry);
        // whoever still waits on the replaced hint (multiplayer preloading of the next round) must not hang forever
        if (this.hintSettled) this.hintSettled();
        $hint.off("load error");
        $hint.hide();
        $wrapper.addClass("loading");
        $hint.attr("src", "");
        $hint.attr("src", url);

        if (guess.submitter) {
            $("#submitter").text(i18next.t("game.hintBy", { ns: "common" }) + " " + guess.submitter);
        }
        else {
            $("#submitter").text("");
        }

        return new Promise((resolve) => {
            this.hintSettled = resolve;
            $hint.on("load", () => {
                $wrapper.removeClass("loading");
                $hint.fadeIn(1200);
                resolve();
            });

            $hint.on("error", () => {
                resolve();
                this.hintRetry = setTimeout(() => {
                    // by URL: the multiplayer reveal swaps currentGuess for a new object of the same round
                    if (this.currentGuess?.url !== guess.url || !$("#map_ui").is(":visible")) return;
                    $hint.attr("src", "");
                    $hint.attr("src", url);
                }, retryDelay(++failures));
            });
        });
    }

    updateRoundDisplay() {
        $("#round").html(`${this.gamePhase + 1}/${this.gameData.length}`);
    }

    disableButtons() {
        this.BUTTON_NEXT.prop("disabled", true);
        this.BUTTON_GUESS.prop("disabled", true);
    }

    handleGuess() {
        if (this.mp.active) return this.mp.submitAnswer();
        if (!this.currentGuess) return;

        this.stopTimer();

        if (this.selectedMode === "mapFinder") {
            this.handleMapGuess();
        } else {
            if (!this.minimap.guessMarker) {
                this.handleNoGuess();
            } else {
                this.processGuess();
            }
        }
        this.checkGameEnd();
    }

    handleMapGuess() {
        const { points } = scoreAnswer("mapFinder", this.currentGuess, { mapName: this.INPUT_GUESS.val() });
        const icon = points ? "✅" : "❌";

        let mapName = this.currentGuess.map;
        mapName = mapName.charAt(0).toUpperCase() + mapName.slice(1);

        $("#points").html(points);
        $("#mapName").html(icon + " " + mapName).fadeIn();
        this.gameData[this.gamePhase - 1].points = points;
        this.addToTotalPoints(points);
        this.BUTTON_GUESS.prop("disabled", true);
        this.BUTTON_NEXT.prop("disabled", false);
        $("#gameWrapper").removeClass("no-map");
        const solutionLatLng = this.getSolutionLatLng();
        this.minimap.invalidateSize();
        this.createSolutionMarker(solutionLatLng);
        this.focusOnSolution(solutionLatLng, 3);
    }



    handleNoGuess() {
        const solutionLatLng = this.getSolutionLatLng();
        $("#points").html(0);
        $("#text").css("visibility", "visible");
        this.createSolutionMarker(solutionLatLng);
        this.focusOnSolution(solutionLatLng);
        this.gameData[this.gamePhase - 1].points = 0;
        this.BUTTON_NEXT.prop("disabled", false);
    }

    processGuess() {
        this.getSolution();
        this.minimap.guessMarker.dragging.disable();
        this.BUTTON_GUESS.prop("disabled", true);
        this.BUTTON_NEXT.prop("disabled", false);
    }

    checkGameEnd() {
        if (this.gamePhase != this.gameData.length) return;
        this.INPUT_GUESS.prop("hidden", true);
        this.BUTTON_NEXT.prop("hidden", true);
        this.BUTTON_GUESS.prop("hidden", true);
        this.BUTTON_RESULTS.prop("hidden", false);
    }

    showResults() {
        this.displayResultsGrid();
        this.updateFinalScore();
        this.checkNewRecord();
        this.updateScoreDisplay();
        this.switchUI("results");
    }

    displayResultsGrid() {
        const $grid = $(".maps-grid");
        $grid.empty();

        this.gameData.forEach(guess => {
            const $img = $(`
                <div class="map-thumbnail">
                    <img src="/api/v2${guess.url}" alt="Guess Image">
                    <span class="roundScore">+${guess.points}</span>
                </div>
            `);
            $grid.append($img);
        });
    }

    updateFinalScore() {
        $("#scoreValue").html(this.score);
        this.saveTopScore(this.selectedMode, this.score);
    }

    checkNewRecord() {
        if (this.score > this.topScores[this.selectedMode]) {
            this.topScores[this.selectedMode] = this.score;
            $(".new-record").fadeIn();
        } else {
            $(".new-record").hide();
        }
    }

    // ===== TIMER MANAGEMENT =====

    startTimeAttackTimer(duration) {
        let remaining = duration;
        $("#timerWrapper").prop("hidden", false);

        if (this.timerInterval) clearInterval(this.timerInterval);

        this.updateTimerDisplay(remaining);

        this.timerInterval = setInterval(() => {
            remaining--;
            this.updateTimerDisplay(remaining);

            if (remaining <= 0) {
                this.stopTimer();
                this.onTimeAttackEnd();
            }
        }, 1000);
    }

    updateTimerDisplay(seconds) {
        $("#totalSeconds").html(seconds);
    }

    stopTimer() {
        $("#timerWrapper").prop("hidden", true);
        if (this.timerInterval) {
            clearInterval(this.timerInterval);
            this.timerInterval = null;
        }
    }

    onTimeAttackEnd() {
        this.BUTTON_GUESS.trigger("click");
    }

    // ===== UI MANAGEMENT =====

    switchUI(page) {

        const uiStates = {
            menu: {
                show: ["#menu", "#footerLogos"],
                hide: ["#map_ui", "#timer_ui", "#results", "#lobby"],
                scoreHidden: true
            },
            timer: {
                show: ["#timer_ui", "#footerLogos"],
                hide: ["#menu", "#map_ui", "#results", "#lobby"],
                scoreHidden: true
            },
            game: {
                show: ["#map_ui"],
                hide: ["#menu", "#timer_ui", "#results", "#footerLogos", "#lobby"],
                scoreHidden: false
            },
            results: {
                show: ["#results", "#footerLogos"],
                hide: ["#map_ui", "#timer_ui", "#menu", "#lobby"],
                scoreHidden: true
            },
            lobby: {
                show: ["#lobby", "#footerLogos"],
                hide: ["#map_ui", "#timer_ui", "#menu", "#results"],
                scoreHidden: true
            }
        };

        const state = uiStates[page];
        if (!state) return;

        state.show.forEach(selector => $(selector).fadeIn(400));
        state.hide.forEach(selector => $(selector).hide());
        $("#score").prop("hidden", state.scoreHidden);
        $("#mapName").hide();
        this.stopTimer();
    }

    selectMode(mode) {
        document.querySelectorAll(".mode-card").forEach(card => {
            card.classList.remove("selected");
        });
        document.querySelector(`[data-mode="${mode}"]`)?.classList.add("selected");
        this.selectedMode = mode;
    }

    selectTimer(timer = 0) {
        document.querySelectorAll(".timer-card").forEach(card => {
            card.classList.remove("selected");
        });
        document.querySelector(`[data-timer="${timer}"]`)?.classList.add("selected");
        this.selectedTimer = timer;
    }

    setButtonLoading(button, isLoading) {
        // a second call with the same value must not store the spinner as the button's text
        if (Boolean(button.data("loading")) === isLoading) return;
        button.data("loading", isLoading);
        if (isLoading) {
            button.data("original-text", button.html());
            button.prop("disabled", true);
            button.html(`<span class="spinner"></span> ${i18next.t("timer.buttons.loading", { ns: "common" })}...`);
        } else {
            button.prop("disabled", false);
            button.html(button.data("original-text") || button.html());
        }
    }

    // ===== SCORING SYSTEM =====

    loadTopScores() {
        const modes = ["classic", "timeAttack", "mapFinder"];
        this.topScores = {};
        modes.forEach(mode => { this.topScores[mode] = this.getStoredScore(mode); });
        this.updateScoreDisplay();
    }

    getStoredScore(mode) {
        const key = `topScore_${mode}`;
        let value = localStorage.getItem(key);

        if (value === null) {
            localStorage.setItem(key, "0");
            return 0;
        }

        return Number(value);
    }

    updateScoreDisplay() {
        $("#classicScore").html(this.topScores.classic);
        $("#timeAttackScore").html(this.topScores.timeAttack);
        $("#mapFinderScore").html(this.topScores.mapFinder);
        $("#mapFinderScore").html(this.topScores.timedMapFinderScore);

    }

    saveTopScore(mode, score) {
        const key = `topScore_${mode}`;
        const current = Number(localStorage.getItem(key)) || 0;
        if (score > current) localStorage.setItem(key, score);
    }

    // ===== SOLUTION CALCULATION =====

    getSolution() {
        const solutionLatLng = this.getSolutionLatLng();
        this.createSolutionMarker(solutionLatLng);
        this.drawSolutionDistance(solutionLatLng);
        this.focusOnSolution(solutionLatLng);
        const distance = this.getSolutionDistance();
        const pointsWon = this.getPoints(distance);
        this.addToTotalPoints(pointsWon);
        this.displaySolutionResults(distance, pointsWon);
    }


    getSolutionLatLng() {
        return [
            this.currentGuess.lat * this.minimap.gameToMapScale,
            this.currentGuess.lng * this.minimap.gameToMapScale
        ];
    }


    displaySolutionResults(distance, points) {
        $("#dist").html(this.formatDistance(distance));
        $("#points").html(points);
        $("#text").css("visibility", "visible");
    }


    addToTotalPoints(points) {
        this.score += points;
        this.animateCalc(this.score, 4000, "totalPoints");
    }


    /**
     * Animate a number with a count-up/down animation
     * @param {number} [goal] - final number to achieve
     * @param {number} [duration] - duration of the animation in ms
     * @param {string} [destination] -  name of the div to look for
     */
    animateCalc(goal, duration, destination) {
        // Ensure target is a number
        const element = $(`#${destination}`);
        let target = element.html();
        target = isNaN(element.html()) ? 0 : Number(element.html());

        const increment = Math.abs(goal - target) / (duration / 16);

        // If goal is an integer, intermediate values will be integers too
        const decimalPlaces = Number.isInteger(Number(goal)) ? 0 : 1;

        function updateCount(current) {
            element.text(current.toFixed(decimalPlaces));

            // Determine the animation direction
            if ((target < goal && current < goal) || (target > goal && current > goal)) {
                requestAnimationFrame(() => updateCount(target < goal ? current + increment : current - increment));
            } else {
                element.text(goal);
            }
        }

        updateCount(target);
    }



    getSolutionDistance() {
        const scale = this.minimap.mapToGameScale;
        const guess = this.minimap.guessMarker.getLatLng();
        return distance(this.currentGuess, { lat: guess.lat * scale, lng: guess.lng * scale });
    }


    getPoints(distance) {
        const { points, icon } = pointsForDistance(distance, this.minimap.activeMap.size);
        this.gameData[this.gamePhase - 1].points = points;
        $("#mapName").html(`${points} ${i18next.t("shared.points", { ns: "common" })} ${icon}`).fadeIn();
        return points;
    }

    formatDistance(meters) {
        if (meters < 10) return `${meters.toFixed(2)}m`;
        if (meters < 1000) return `${meters.toFixed(0)}m`;
        return `${(meters / 1000).toFixed(1)}km`;
    }

    // ===== MAP VISUALIZATION =====

    createSolutionMarker(latLng) {
        this.solutionMarker = new solutionMarker(latLng, {}, this).addTo(this.minimap.markersGroup);
    }

    drawSolutionDistance(latLng, from = this.minimap.guessMarker.getLatLng(), style = {}) {
        new Polyline(
            [from, latLng],
            {
                color: "#ff4d4d",
                weight: 3,
                opacity: 0.9,
                dashArray: "6,4",
                ...style,
                showMeasurements: true,
                measurementOptions: {
                    minPixelDistance: 50,
                    scaling: this.minimap.mapToGameScale,
                }
            }
        ).addTo(this.minimap.markersGroup);
    }

    focusOnSolution(latLng, zoom = 6) {
        if (!latLng) return;

        if (!this.minimap.guessMarker) {
            this.minimap.flyTo(latLng, zoom, {
                //animate: true,
                duration: 1.5
            });
            return;
        }

        const bounds = new LatLngBounds([this.minimap.guessMarker.getLatLng(), latLng]);
        this.minimap.flyToBounds(bounds, {
            padding: [100, 100],
            maxZoom: zoom,
            animate: true,
            duration: 1.5
        });
    }

    // ===== MAP MANAGEMENT =====

    loadMinimap() {
        this.minimap = new squadMinimap("map", this.MAPSIZE, MAPS[0]);
    }

    // ===== UI UTILITIES =====

    closeMenu() {
        $("#footerButtons").removeClass("expanded");
        $(".fab4").html("<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 448 512\"><path d=\"M0 96C0 78.3 14.3 64 32 64l384 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 128C14.3 128 0 113.7 0 96zM0 256c0-17.7 14.3-32 32-32l384 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 288c-17.7 0-32-14.3-32-32zM448 416c0 17.7-14.3 32-32 32L32 448c-17.7 0-32-14.3-32-32s14.3-32 32-32l384 0c17.7 0 32 14.3 32 32z\"/></svg>");
    }

    loadUI() {
        //this.closeDialogOnClickOutside(helpDialog);
        this.setupToast();
        this.setupUIControls();
        this.show();
    }

    setupToast() {
        let countdown;

        const closeToast = () => {
            const toast = document.querySelector("#toast");
            if (!toast) return;
            toast.style.animation = "close 0.3s cubic-bezier(.87,-1,.57,.97) forwards";
            document.querySelector("#timer")?.classList.remove("timer-animation");
            clearTimeout(countdown);
        };

        this.openToast = (type, title, text) => {
            const toast = document.querySelector("#toast");
            clearTimeout(countdown);

            const timer = document.querySelector("#timer");
            timer?.classList.remove("timer-animation");
            void timer?.offsetWidth; // Trigger reflow
            timer?.classList.add("timer-animation");

            toast.classList = [type];
            toast.style.animation = "open 0.3s cubic-bezier(.47,.02,.44,2) forwards";

            toast.querySelector("h4").innerHTML = title;
            toast.querySelector("p").innerHTML = text;

            countdown = setTimeout(closeToast, 5000);
        };

        document.querySelector("#toast")?.addEventListener("click", (event) => {
            const toast = document.querySelector("#toast");
            const title = toast.querySelector("h4")?.getAttribute("data-i18n");

            closeToast();

            if (title === "tooltips:sessionCreated" && event.target.tagName !== "BUTTON") {
                this.copySessionUrl();
            }
        });
    }

    setupUIControls() {
        //$("#fabCheckbox2").on("change", () => this.switchUI("menu"));
        this.setupControlButtons("#canvasControls", ".sim");
        this.setupControlButtons("#settingsControls", ".panel");
    }

    setupControlButtons(controlSelector, targetSelector) {
        $(`${controlSelector} button`).on("click", (event) => {
            const $button = $(event.currentTarget);
            if ($button.hasClass("active")) return;

            $(`${controlSelector} > .active`).first().removeClass("active");
            $button.addClass("active");
            $(`${targetSelector}.active`).removeClass("active");
            $(`#${$button.val()}`).addClass("active");
        });
    }

    show() {
        document.body.style.visibility = "visible";
        setTimeout(() => {
            $("#loaderLogo").fadeOut("slow", () => {
                $("#loader").fadeOut("fast");
            });
        }, 1300);
    }

    closeDialogOnClickOutside(dialog) {
        dialog?.addEventListener("click", function (event) {
            const RECT = dialog.getBoundingClientRect();
            const isInDialog = (
                RECT.top <= event.clientY &&
                event.clientY <= RECT.top + RECT.height &&
                RECT.left <= event.clientX &&
                event.clientX <= RECT.left + RECT.width
            );
            if (!isInDialog) {
                dialog.close();
            }
        });
    }


    // updateUrlParams(updates = {}) {
    //     const urlParams = new URLSearchParams(window.location.search);

    //     // Apply updates
    //     for (const [key, value] of Object.entries(updates)) {
    //         if (value !== null && value !== undefined) {
    //             urlParams.set(key, value);
    //         } else {
    //             urlParams.delete(key);
    //         }
    //     }

    //     // Sort parameters
    //     const sortedParams = new URLSearchParams();
    //     const paramOrder = ["map", "layer", "type", "session"];

    //     paramOrder.forEach((param) => {
    //         if (urlParams.has(param)) {
    //             sortedParams.set(param, urlParams.get(param));
    //             urlParams.delete(param);
    //         }
    //     });

    //     // Add remaining parameters
    //     for (const [key, value] of urlParams.entries()) {
    //         sortedParams.set(key, value);
    //     }

    //     // Update URL
    //     const newUrl = `${window.location.pathname}?${sortedParams.toString()}`;
    //     window.history.replaceState({}, "", newUrl);
    // }
}