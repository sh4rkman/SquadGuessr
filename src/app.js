// Node Modules
import "animate.css";
import "leaflet/dist/leaflet.css";

// Local Styles

import "./components/index.scss";
import "./components/header/header.scss";
import "./components/menu/menu.scss";
import "./components/game/game.scss";
import "./components/results/results.scss";
import "./components/footer/footer.scss";
import "./components/shared/_variables.scss";
import "./components/game/mapLogo.scss";


// JS
import SquadGuessr from "./js/squadGuessr.js";

/***************/
// Start the App
/***************/

var options = {
    supportedLanguages: [
        ["en", "EN"],
        ["zh", "中文"],
        ["uk", "UKR"],
        ["ru", "РУС"],
        ["fr", "FR"],
        ["de", "DE"]
    ],
    mapSize: 256,
};

export var App = new SquadGuessr(options);

App.init();