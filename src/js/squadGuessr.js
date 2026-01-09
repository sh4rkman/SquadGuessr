import { MAPS, initMapsProperties } from "./data/maps.js";
import { squadMinimap } from "./squadMinimap.js";
import { loadLanguage } from "../i18n/i18n.js";
import { Polyline, LatLngBounds } from "leaflet";
import SquadSettings from "./squadSettings.js";
import packageInfo from "../../package.json";
import i18next from "i18next";
import { solutionMarker } from "./guessMarker.js";
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
    }

    initializeElements() {
        this.BUTTON_NEXT = $("#BUTTON_NEXT");
        this.BUTTON_GUESS = $("#BUTTON_GUESS");
        this.BUTTON_NEWGAME = $("#BUTTON_PLAY");
        this.BUTTON_RESULTS = $("#BUTTON_RESULTS");
        this.BUTTON_PLAYAGAIN = $("#BUTTON_PLAYAGAIN");
        this.MAIN_LOGO = $("#MAINLOGO");
        this.INPUT_GUESS = $("#searchMap");
    }

    // ===== INITIALIZATION =====

    init() {
        this.initializeCore();
        this.setupEventListeners();
        console.log(`SquadGuessr v${this.version} Loaded!`);
    }

    initializeCore() {
        loadLanguage(this.supportedLanguages);
        initMapsProperties();
        this.loadTopScores();
        this.userSettings.init();
        this.loadMinimap();
        this.loadUI();
        //updateContent();
        this.selectMode("classic", 60);
    }

    setupEventListeners() {
        this.setupModeSelection();
        this.setupGameButtons();
        this.setupNavigationButtons();
        this.setupImageOverlay();
        this.setupGuessInput();
    }

    setupModeSelection() {
        document.querySelectorAll(".mode-card").forEach(card => {
            card.addEventListener("click", () => {
                const mode = card.getAttribute("data-mode");
                const timer = card.getAttribute("data-timer");
                this.selectMode(mode, timer);
            });
        });
    }

    setupGameButtons() {
        this.BUTTON_NEWGAME.on("click", () => this.startNewGame());
        this.BUTTON_GUESS.on("click", () => this.handleGuess());
        this.BUTTON_NEXT.on("click", () => this.loadNextGuess());
        this.BUTTON_RESULTS.on("click", () => this.showResults());
    }

    setupNavigationButtons() {
        this.BUTTON_PLAYAGAIN.on("click", () => this.switchUI("menu"));
        this.MAIN_LOGO.on("click", () => {
            this.stopTimer();
            this.switchUI("menu");
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

    startNewGame() {
        this.setButtonLoading(this.BUTTON_NEWGAME, true);
        const ROUND_NUMBER = 5;

        this.getGuess(ROUND_NUMBER)
            .catch(error => {
                this.setButtonLoading(this.BUTTON_NEWGAME, false);
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
            });
    }

    initializeGameState(gameData) {
        this.gameData = gameData;
        this.gamePhase = 0;
        this.score = 0;

        $("#totalPoints").html(0);
        this.INPUT_GUESS.val("");
        
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
            
            return data;
        } catch (error) {
            //console.debug("Error fetching layers data:", error);
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
        const map = MAPS.find(m => m.name.toLowerCase() === mapName.toLowerCase());
        if (!map) {
            console.error(`Map "${mapName}" not found ❌`);
            console.log('Available maps:');
            MAPS.forEach(m => console.log(`  - ${m.name}`));
            return;
        }
        this.minimap.clear();
        this.minimap.activeMap = map;
        this.minimap.draw(true);
        console.debug(`Map changed to: ${map.name} ✅`);
        console.debug(`Click anywhere on the map to log the latlng`);
    }

    setupMap() {
        const map = MAPS.find(m => m.name.toLowerCase() === this.currentGuess.map.toLowerCase());
        this.minimap.clear();
        this.minimap.activeMap = map;
        this.minimap.draw(true);
    }

    setupHint() {
        
        return new Promise((resolve) => {
            const $hint = $("#hint");
            $hint.off("load error");
            $hint.hide();
            $hint.attr("src", "");
            $hint.attr("src", `/api/v2${this.currentGuess.url}`);


            // // Check if already loaded (cached)
            // if ($hint[0].complete && $hint[0].naturalHeight !== 0) {
            //     resolve();
            // } else {

                $hint.on("load", () => {
                    $hint.fadeIn(1200);
                    resolve();
                });

            //     $hint.on("error", (err) => {
            //         console.error("Failed to load hint image", err);
            //         resolve(); // Resolve anyway to not block the timer
            //     });
            // }
           
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

    handleMapGuess(){
        let points = 0;
        let icon = "❌";

        if (this.levenshtein(this.INPUT_GUESS.val(), this.currentGuess.map) <= 2 ) {
            points = 100;
            icon = "✅";
        }

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



    levenshtein(a, b) {

        function normalize(str) {
            return str.toLowerCase().trim().replace(/\s+/g, " ");
        }

        a = normalize(a);
        b = normalize(b);

        // ⬇️ NEW: compact version of user input
        const compactA = a.replace(/\s/g, "");

        // 1️⃣ Direct compact match
        if (compactA === b) return 0;

        const words = a.split(" ");
        let best = Infinity;

        for (const word of words) {

            const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
            for (let j = 0; j <= word.length; j++) matrix[0][j] = j;

            for (let i = 1; i <= b.length; i++) {
                for (let j = 1; j <= word.length; j++) {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j] + 1,
                        matrix[i][j - 1] + 1,
                        matrix[i - 1][j - 1] + (b[i - 1] === word[j - 1] ? 0 : 1)
                    );
                }
            }

            best = Math.min(best, matrix[b.length][word.length]);
        }

        return best;
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
        //console.debug("switching UI to", page);
        
        const uiStates = {
            menu: {
                show: ["#menu", "#footerLogos"],
                hide: ["#map_ui", "#results"],
                scoreHidden: true
            },
            game: {
                show: ["#map_ui"],
                hide: ["#menu", "#results", "#footerLogos"],
                scoreHidden: false
            },
            results: {
                show: ["#results", "#footerLogos"],
                hide: ["#map_ui", "#menu"],
                scoreHidden: true
            }
        };

        const state = uiStates[page];
        if (!state) return;
        
        state.show.forEach(selector => $(selector).fadeIn(400));
        state.hide.forEach(selector => $(selector).hide());
        $("#score").prop("hidden", state.scoreHidden);
        $("#mapName").hide();
    }

    selectMode(mode, timer = 0) {
        document.querySelectorAll(".mode-card").forEach(card => {
            card.classList.remove("selected");
        });
        document.querySelector(`[data-mode="${mode}"]`)?.classList.add("selected");
        this.selectedMode = mode;
        this.selectedTimer = timer;
    }

    setButtonLoading(button, isLoading) {
        if (isLoading) {
            button.data("original-text", button.html());
            button.prop("disabled", true);
            button.html(`<span class="spinner"></span> ${i18next.t("menu.buttons.loading", { ns: "common" })}...`);
        } else {
            button.prop("disabled", false);
            button.html(button.data("original-text") || button.html());
        }
    }

    // ===== SCORING SYSTEM =====

    loadTopScores() {
        const modes = ["classic", "timeAttack", "mapFinder"];
        this.topScores = {};
        modes.forEach(mode => { this.topScores[mode] = this.getStoredScore(mode);});
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
        const solutionLatLng = [this.currentGuess.lat, this.currentGuess.lng];
        const guessLatLng = [
            this.minimap.guessMarker.getLatLng().lat * this.minimap.mapToGameScale,
            this.minimap.guessMarker.getLatLng().lng * this.minimap.mapToGameScale
        ];
        
        const dx = solutionLatLng[1] - guessLatLng[1];
        const dy = solutionLatLng[0] - guessLatLng[0];
        
        return Math.sqrt(dx * dx + dy * dy);
    }


    getPoints(distance) {
    // base thresholds for a 3000x3000 map
        const baseSteps = [
            { maxDistance: 20, points: 100, icon: "! 💯" },
            { maxDistance: 50, points: 80, icon: "! 🌟"  },
            { maxDistance: 100, points: 60, icon: "👏🏼"  },
            { maxDistance: 200, points: 40, icon: "👍🏼" },
            { maxDistance: 300, points: 20, icon: "😐" },
            { maxDistance: 500, points: 10, icon: ".. 🤨" },
        ];
        const mapSize = this.minimap.activeMap.size;
        const scale = mapSize / 3000; // 1 for base map, >1 for bigger maps, <1 for smaller
    
        // scale thresholds
        const steps = baseSteps.map(s => ({
            maxDistance: s.maxDistance * scale,
            points: s.points,
            icon: s.icon
        }));
    
        let points;
        let icon = ""; // Add this to track the icon
    
        if (distance <= steps[0].maxDistance) {
            points = steps[0].points;
            icon = steps[0].icon;
        } else if (distance > steps[steps.length - 1].maxDistance) {
            points = 0;
            icon = "... ❌"; // Or whatever icon you want for 0 points
        } else {
            points = this.interpolatePoints(distance, steps);
            // Find the appropriate icon based on distance
            icon = steps.find(s => distance <= s.maxDistance)?.icon || "";
        }
    
        this.gameData[this.gamePhase - 1].points = points;
        $("#mapName").html(`${points} ${i18next.t("shared.points", { ns: "common" })} ${icon}`).fadeIn();
        return points;
    }


    interpolatePoints(distance, steps) {
        for (let i = 1; i < steps.length; i++) {
            if (distance <= steps[i].maxDistance) {
                const prevStep = steps[i - 1];
                const currStep = steps[i];
                
                const distanceRange = currStep.maxDistance - prevStep.maxDistance;
                const pointsRange = currStep.points - prevStep.points;
                const distanceIntoRange = distance - prevStep.maxDistance;
                
                return Math.round(prevStep.points + (pointsRange * distanceIntoRange / distanceRange));
            }
        }
        return 0;
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

    drawSolutionDistance(latLng) {
        new Polyline(
            [this.minimap.guessMarker.getLatLng(), latLng],
            {
                color: "#ff4d4d",
                weight: 3,
                opacity: 0.9,
                dashArray: "6,4",
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
        
            toast.querySelector("h4")?.setAttribute("data-i18n", `tooltips:${title}`);
            toast.querySelector("h4").innerHTML = i18next.t(`tooltips:${title}`);
            toast.querySelector("p")?.setAttribute("data-i18n", `tooltips:${text}`);
            toast.querySelector("p").innerHTML = i18next.t(`tooltips:${text}`);
        
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
        $("#fabCheckbox2").on("change", () => this.switchUI("menu"));
        
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
        dialog?.addEventListener("click", function(event) {
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