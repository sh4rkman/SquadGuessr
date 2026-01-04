import { App } from "../app.js";
import { Marker, Circle, Icon } from "leaflet";
import i18next from "i18next";


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
        const ICON_SIZE_X = 28 + (App.userSettings.markerSize - 1) * 5;
        const ICON_SIZE_Y = ICON_SIZE_X * (47 / 38);
        this.setIcon(
            new Icon({
                    iconUrl: `/img/guess.webp`,
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
        //this.createPointsCircles();
        this.updateIcon();
    },

    createPointsCircles(){
        const distances = [20, 100, 200, 500, 750];
        const pointsMap = {
            20: 100,
            100: 75,
            200: 50,
            500: 25,
            750: 10
        };

        distances.forEach((d) => {
            console.log(d)
            console.log(this.map.minimap.gameToMapScale)

            const radius = d * this.map.minimap.gameToMapScale;

            const circle = new Circle(this.getLatLng(), {
                radius: radius,
                color: "white",
                weight: 2,
                opacity: 0.7,
                fillOpacity: 0.0, // transparent fill
                dashArray: "4,4",
            }).addTo(this.map.minimap.activeMarkers);

            this.circles.push(circle);



            const offsetLat = this.getLatLng().lat - (radius); 
            const points = pointsMap[d] || 0;

            // const label = new Marker([offsetLat, this.getLatLng().lng], {
            //     icon: new DivIcon({
            //         className: "circle-label",
            //         html: `<span>${points}pts</span>`,
            //         iconSize: [50, 50],
            //     }),
            //     interactive: false 
            // }).addTo(this.map.minimap.activeMarkers);

            //this.circles.push(label);

        });
    },

    delete() {
        this.map.guessMarker = null;
        this.remove();
    },


    /**
     * Update the weapon icon based on user settings and number of weapons
    */
    updateIcon: function(){
        const ICON_SIZE_X = 38 + (App.userSettings.markerSize - 1) * 5;
        const ICON_SIZE_Y = ICON_SIZE_X * (47 / 38);
        this.setIcon(
            new Icon({
                    iconUrl: `/img/solution.webp`,
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