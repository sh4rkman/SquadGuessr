// import { App } from "../app.js";
import { Marker, Icon } from "leaflet";


/*
 * Global Squad Marker Class 
*/
export const guessMarker = Marker.extend({

    options: {
        draggable: true,
        riseOnHover: true,
        keyboard: false,
        animate: true,
    },

    // Constructor
    initialize: function (latlng, options, map) {
        Marker.prototype.initialize.call(this, latlng, options);
        this.map = map;
        this.on("drag", this._handleDrag, this);
        this.updateIcon();
    },

    _handleDrag: function (event) {
        event = this.keepOnMap(event);
        this.setLatLng(event.latlng);
    },


    /**
     * Right-Click
     * Place a new WeaponMarker / Open ContextMenu
     */
    _handleContextMenu: function() {
        this.delete();
    },


    /**
     * Force a given event to stay inside the map bounds
     * @param {event} [event] - event
     * @returns {event} - same event with corrected Latlng 
     */
    keepOnMap: function(event){
        if (event.latlng.lng > this.map.pixelSize) event.latlng.lng = this.map.pixelSize;
        if (event.latlng.lat < -this.map.pixelSize) event.latlng.lat = -this.map.pixelSize;
        if (event.latlng.lng < 0) event.latlng.lng = 0;
        if (event.latlng.lat > 0) event.latlng.lat = 0;
        return event;
    },

    /**
     * Update the weapon icon based on user settings and number of weapons
    */
    updateIcon: function(){
        const ICON_SIZE_X = 38;
        const ICON_SIZE_Y = ICON_SIZE_X * (47 / 38);
        this.setIcon(
            new Icon({
                iconUrl: "/img/guess.webp",
                shadowUrl: "/img/marker_shadow.webp",
                iconSize:     [ICON_SIZE_X, ICON_SIZE_Y],
                shadowSize:   [ICON_SIZE_X, ICON_SIZE_Y],
                iconAnchor:   [ICON_SIZE_X / 2, ICON_SIZE_Y],
                shadowAnchor: [ICON_SIZE_X / 4, ICON_SIZE_Y],
                className: "animatedWeaponMarker"
            })
        );
    },

});


/*
 * Global Squad Marker Class 
*/
export const solutionMarker = Marker.extend({

    options: {
        draggable: false,
        riseOnHover: true,
        keyboard: false,
        animate: true,
    },

    // Constructor
    initialize: function (latlng, options, map) {
        Marker.prototype.initialize.call(this, latlng, options);
        this.map = map;
        this.circles = [];
        this.updateIcon();
    },


    delete() {
        this.map.guessMarker = null;
        this.remove();
    },


    /**
     * Update the weapon icon based on user settings and number of weapons
    */
    updateIcon: function(){
        const ICON_SIZE_X = 48;
        const ICON_SIZE_Y = ICON_SIZE_X * (47 / 38);
        this.setIcon(
            new Icon({
                iconUrl: "/img/solution.webp",
                shadowUrl: "/img/marker_shadow.webp",
                iconSize:     [ICON_SIZE_X, ICON_SIZE_Y],
                shadowSize:   [ICON_SIZE_X, ICON_SIZE_Y],
                iconAnchor:   [ICON_SIZE_X / 2, ICON_SIZE_Y],
                shadowAnchor: [ICON_SIZE_X / 4, ICON_SIZE_Y],
                className: "animatedWeaponMarker"
            })
        );
    },

});