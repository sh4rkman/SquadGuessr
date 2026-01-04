import { ImageOverlay, Map, CRS, SVG, Util, LayerGroup, Popup, LatLngBounds, Browser } from "leaflet";
import { App } from "../app.js";
import { guessMarker } from "./guessMarker.js";
import "./libs/leaflet-smoothWheelZoom.js";
import "./libs/leaflet-edgebuffer.js";
import "./libs/leaflet-spin.js";


/**
 * Squad Minimap
 * Custom Leaflet Map for Squad, managing basemaps, mouse behaviours, and more
 * @extends {Map} - Leaflet Map
 * @class squadMinimap
 */
export const squadMinimap = Map.extend({

    /**
     * Initialize Map
     * @param {HTMLElement} [id] - id of the map in the HTML
     * @param {Number} [pixelSize] - Size in pixel of the tiles
     * @param {Object} [defaultMap] - squad map to initialize
     * @param {Array} [options]
     */
    initialize: function (id, pixelSize, defaultMap, options) {

        let customOptions = {
            attributionControl: false,
            boxZoom: true,
            center: [-pixelSize/2, pixelSize/2],
            closePopupOnClick: false,
            crs: CRS.Simple,
            doubleClickZoom: false,
            maxZoom: 8,
            minZoom: 1,
            renderer: new SVG({ padding: 3}),
            zoom: 2,
            zoomControl: true,
            zoomSnap: 0,
            smoothSensitivity: 2,
            scrollWheelZoom: false,
            smoothWheelZoom: true,
            wheelPxPerZoomLevel: 60,
            inertia: false,
            zoomAnimation: false,
        };

        Util.setOptions(this, customOptions);
        Map.prototype.initialize.call(this, id, options);
        this.activeMap = defaultMap;
        this.pixelSize = pixelSize;
        this.imageBounds = new LatLngBounds({lat: 0, lng:0}, {lat: -this.pixelSize, lng: this.pixelSize});
        this.spinOptions = {color: "white", scale: 1.5, width: 5, shadow: "5px 5px 5px transparent"};
        this.activeTargetsMarkers = new LayerGroup().addTo(this);
        this.activeWeaponsMarkers = new LayerGroup().addTo(this);
        this.targetGrids = new LayerGroup().addTo(this);
        this.activeMarkers = new LayerGroup().addTo(this);
        this.activeArrowsGroup = new LayerGroup().addTo(this);
        this.activeRectanglesGroup = new LayerGroup().addTo(this);
        this.activeCirclesGroup = new LayerGroup().addTo(this);
        this.activeDrawingGroup = new LayerGroup().addTo(this);
        this.activeArrows = [];
        this.activeRectangles = [];
        this.activeCircles = [];
        this.activePolylines = [];
        this.layerGroup = new LayerGroup().addTo(this);
        this.markersGroup = new LayerGroup().addTo(this);
        this.history = [];
        this.mouseLocationPopup = new Popup({
            closeButton: false,
            className: "kpPopup",
            autoClose: false,
            closeOnEscapeKey: false,
            offset: [0, 75],
            autoPan: false,
            closeOnClick: false,
            interactive: false,
        });


        
        if (!Browser.mobile) {
            // On desktop create markers with a double click
            this.on("click", function(e) { this._handleclick(e); });
            this.on("dblclick", function(e) { this._handleDoubleClick(e); });
        } else {
            // On mobile just use single click
            this.on("click", function(e) { this._handleDoubleClick(e);});
            this.on("dblclick", function() { return false; });
        }

        this.on("contextmenu", this._handleContextMenu, this);

    },


    /**
     * Initiate Heightmap & Grid then load layer
     */
    draw: function(){
        this.gameToMapScale = this.pixelSize / this.activeMap.size;
        this.gameToMapScaleY = this.pixelSize / this.activeMap.sizeY;
        this.mapToGameScale = this.activeMap.size / this.pixelSize;
        this.detailedZoomThreshold = ( 3 + (this.activeMap.size / 7000) ) * 0.8;
       
        // load map
        this.changeLayer(true);
    },


    /**
     * remove existing layer and replace it
     */
    changeLayer: function() {
        const OLDLAYER = this.activeLayer;

        // Show spinner
        this.spin(true, this.spinOptions);

        let imagePath = `${this.activeMap.mapURL}basemap`;

        // Use ImageOverlay for standard images
        imagePath = `${imagePath}.webp`;
        this.activeLayer = new ImageOverlay(imagePath, this.imageBounds);
        this.activeLayer.addTo(this.layerGroup);
        $(this.activeLayer.getElement()).css("opacity", 0);
        
        this.activeLayer.once("load", () => {
            // Animate the opacity of the new layer
            $(this.activeLayer.getElement()).fadeTo(700, 1, () => {
                if (OLDLAYER) OLDLAYER.remove();
                this.spin(false);
            });
        });

        this.activeLayer.once("error", (e) => {
            console.error("Error loading", e.sourceTarget._url);
            if (OLDLAYER) OLDLAYER.remove();
            this.spin(false);
        });

    },


    /**
     * Force the Browser to decode of the current map image
     * Hack for Chrome lag when first zooming inside a 4k image
     */
    decode: function(){
        const IMG = new Image();
        IMG.src = this.activeLayer._url;
        IMG.decode();
    },


    /**
     * Reset map by clearing every Markers/Layers
     */
    clear: function(){

        // Clear Every existing Markers
        this.markersGroup.clearLayers();
        this.guessMarker = null;

        // Reset map view
        this.setView([-this.pixelSize/2, this.pixelSize/2], 2);
    },


    /**
     * Return true if there is at least one marker on the map
     * @returns {Boolean}
     */
    hasMarkers: function(){
        return (
            this.activeArrows.length > 0 ||
            this.activeMarkers.getLayers().length > 0 ||
            this.activeTargetsMarkers.getLayers().length > 0 ||
            this.activeRectangles.length > 0 ||
            this.activeCircles.length > 0 ||
            this.activePolylines.length > 0
        );
    },


    /**
     * Add a new weapon marker to the minimap
     * @param {LatLng} latlng - coordinates of the new weapon
     **/
    createGuessMarker(latlng){
        if (!this.guessMarker && App.selectedMode != "mapFinder") {
            this.guessMarker = new guessMarker(latlng, {}, this).addTo(this.markersGroup);
            App.BUTTON_GUESS.prop("disabled", false);
        } else {
            if (this.guessMarker.dragging._enabled) this.guessMarker.setLatLng(latlng);
        }
    },


    /**
     * Map onClick event handler
     * If in Session, create a visual ping and send it to the session
     * @param {event} event
     */
    _handleclick: function(event) {
        this.logLatLng(event.latlng);
        if (!this.imageBounds.contains(event.latlng)) return;
        this.createGuessMarker(event.latlng);
    },


    logLatLng(latLng) {
        let lat = `"lat": ${latLng.lat * this.mapToGameScale}`;
        let lng = `"lng": ${latLng.lng * this.mapToGameScale}`;
        console.debug(`${lat}, ${lng}`);
    },
    
    /**
     * Right-Click
     */
    _handleContextMenu: function() {
    },


    /**
     * Double-Click
     * Create a new target, or weapon is none exists
     */
    _handleDoubleClick: function (event) {
        if (!this.imageBounds.contains(event.latlng)) return;
        this.createGuessMarker(event.latlng);
    },

});