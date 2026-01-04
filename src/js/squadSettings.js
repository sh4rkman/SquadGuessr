/**
 * Centralized settings management.
 * Handles loading, saving, and UI binding for all user preferences.
 */
export default class SquadSettings {

    static get TYPES() {
        return {
            CHECKBOX: "checkbox",
            SLIDER: "slider"
        };
    }

    constructor(app) {
        this.app = app;
        this.definitions = this.getCheckboxDefinitions();
    }

    /**
     * Initialize all settings - call after DOM is ready
     */
    init() {
        this.loadCheckboxes();
        this.bindCheckboxes();
        this.bindLabelClicks();
        this.applyInitialState();
    }


    /**
     * Checkbox setting definitions
     * Each setting has: key (localStorage), default, selector, and optional onChange handler
     */
    getCheckboxDefinitions() {
        return {
            lineToTarget: {
                key: "settings-line-to-target",
                default: false,
                selector: "#lineToTargetSetting",
                onChange: () => this.app.minimap.updateTargets()
            },
            targetAnimation: {
                key: "settings-target-animation",
                default: true,
                selector: "#targetAnimationSettings",
                onChange: () => {
                    this.app.minimap.activeTargetsMarkers.eachLayer((target) => {
                        target.updateCalcPopUps();
                        target.updateIcon();
                    });
                }
            },
            disableSounds: {
                key: "settings-disable-sounds",
                default: false,
                selector: "#disableSoundsSettings"
            },
            contextMenu: {
                key: "settings-contextmenu",
                default: true,
                selector: "#contextMenuSettings"
            },
        };
    }

    /**
     * Load all checkbox settings from localStorage
     */
    loadCheckboxes() {
        Object.entries(this.definitions).forEach(([name, def]) => {
            // Handle mouse-dependent settings
            if (def.requiresMouse && !this.app.hasMouse) {
                this[name] = false;
                if (def.selector) {
                    $(def.selector).prop("disabled", true).prop("checked", false);
                }
                return;
            }

            const stored = localStorage.getItem(def.key);
            if (stored === null || isNaN(stored) || stored === "") {
                localStorage.setItem(def.key, def.default ? 1 : 0);
                this[name] = def.default;
            } else {
                this[name] = stored === "1" || stored === "true";
            }

            // Update checkbox state
            if (def.selector) {
                $(def.selector).prop("checked", this[name]);
            }

            // Call onLoad if defined
            if (def.onLoad) {
                def.onLoad(this[name]);
            }
        });
    }

    /**
     * Create tick marks for a slider
     */
    createSliderTicks(def) {
        const ticks = document.getElementById(def.ticksSelector.replace("#", ""));
        if (!ticks) return;

        def.tickValues.forEach((val, index) => {
            const tick = document.createElement("div");
            tick.className = "tick";
            tick.setAttribute("data-value", def.formatTick(val));
            
            const percent = ((val - def.min) / (def.max - def.min)) * 100;
            tick.style.left = percent + "%";
            
            if (index === def.defaultTickIndex) {
                tick.classList.add("default-tick");
            }
            ticks.appendChild(tick);
        });
    }


    /**
     * Bind change events to all checkboxes
     */
    bindCheckboxes() {
        Object.entries(this.definitions).forEach(([name, def]) => {
            if (!def.selector) return;

            $(def.selector).on("change", () => {
                const val = $(def.selector).is(":checked");
                this.set(name, val);
            });
        });
    }

    /**
     * Bind click events to setting labels for toggle behavior
     */
    bindLabelClicks() {
        $(".toggleCheckbox").on("click", function() {
            const checkbox = $(this).closest("tr").find("input[type='checkbox']");
            if (checkbox.prop("disabled")) return;
            checkbox.prop("checked", !checkbox.prop("checked")).trigger("change");
            //animateCSS($(this).closest("td"), "headShake");
        });
    }


    /**
     * Apply initial state after loading (e.g., CSS filters, cursor, map mode)
     */
    applyInitialState() {
        //$("#map").css("cursor", "crosshair");
    }


    /**
     * Set a setting value and trigger side effects
     * @param {string} name - Setting name
     * @param {*} value - New value
     */
    set(name, value) {
        const def = this.definitions[name] || this.sliderDefinitions[name];
        if (!def) {
            console.warn(`Unknown setting: ${name}`);
            return;
        }

        this[name] = value;
        localStorage.setItem(def.key, +value);

        if (def.onChange) {
            def.onChange(value);
        }
    }

    /**
     * Get a setting value
     * @param {string} name - Setting name
     * @returns {*} Setting value
     */
    get(name) {
        return this[name];
    }
}
