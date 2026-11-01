import i18next from "i18next";
import { CircleMarker, LayerGroup, SVG } from "leaflet";

/**
 * Dots of the guesses already in the game on a minimap, to spot the areas nobody covered yet
 * (used by the submit and review views)
 */
export class ExistingGuesses {
    constructor(minimap, app) {
        this.minimap = minimap;
        this.app = app;
        // counts position fetches: only the latest map's answer may be drawn
        this.audits = 0;
        // own pane above the basemap (overlayPane, 400) and under the marker (markerPane, 600);
        // own group since markersGroup is cleared by minimap.clear()
        const pane = minimap.createPane("existingGuesses");
        pane.style.zIndex = 450;
        // only the dots themselves take the mouse (leaflet-interactive), for their tooltip
        pane.style.pointerEvents = "none";
        this.group = new LayerGroup().addTo(minimap);
        // same padding as the map's renderer: dots stay drawn while panning
        this.renderer = new SVG({ pane: "existingGuesses", padding: 3 });
    }

    /**
     * Draws a dot on every guess position the API already holds for the given map (none for null)
     */
    async show(map) {
        const audit = ++this.audits;
        this.group.clearLayers();
        if (!map) return;
        let positions;
        try {
            const response = await fetch(`/api/get/squadGuess/positions?map=${encodeURIComponent(map.name)}`, {
                headers: { "X-App-Version": this.app.version }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            // { map, count, positions: [{ lat, lng, mode }] } in game coordinates
            ({ positions } = await response.json());
        } catch (error) {
            console.debug("Error fetching existing guess positions", error);
            return;
        }
        // another map may have been chosen while this one was loading
        if (audit !== this.audits || !Array.isArray(positions)) return;
        // colours in submit.scss (.submit-existing)
        positions.forEach(p => this.dot(p, "submit-existing", "submit.existingGuess").addTo(this.group));
    }

    /**
     * A dot like the existing guesses' for a position in game coordinates, coloured by the given class
     * @param {string} label - i18n key of the tooltip shown on hover
     * @returns {CircleMarker} not added to any layer yet
     */
    dot({ lat, lng }, className, label) {
        const scale = this.minimap.gameToMapScale;
        return new CircleMarker([lat * scale, lng * scale], {
            pane: "existingGuesses",
            renderer: this.renderer,
            className,
            radius: 5,
            weight: 1.5,
            fillOpacity: 0.9,
            // clicks still reach the map: a marker can be placed on a dot
            bubblingMouseEvents: true,
        }).bindTooltip(tooltip(label), { direction: "top" });
    }
}

/**
 * Tooltip content read when it opens, so it follows a language change
 */
export function tooltip(label) {
    return () => i18next.t(label, { ns: "common" });
}
