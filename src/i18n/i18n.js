import i18next from "i18next";
//import { App } from "../app.js";
import enCommon from "./en.json";
import zhCommon from "./zh.json";

/**
 * Update every label with the correct localization text
 */
export function loadLanguage(LANGUAGES) {
    const LANG_SELECTOR = $(".dropbtn4");

    LANG_SELECTOR.select2({
        dropdownCssClass: "dropbtn4",
        width: "80px",
        minimumResultsForSearch: -1,
    });

    LANGUAGES.forEach(function(lng) {
        LANG_SELECTOR.append(`<option value=${lng[0]}>${lng[1]}</option>`);
    });

    $(document).on("change", ".dropbtn4", function() {
        i18next.changeLanguage(this.value, updateContent);
        localStorage.setItem("settings-language", this.value);
        $("html").attr("lang", this.value);
    });


    i18next.init({
        fallbackLng: "en",
        ns: [ "common" ],
        defaultNS: "common",
        debug: false,
        resources: {
            en: {
                common: enCommon
            },
            zh: {
                common: zhCommon
            }
        }
    }, function(err) {
        if (err) return console.error(err);
        getLanguage(LANGUAGES);
    });

    updateContent();
}

/**
 * Find what language to use
 * Priority Order : LocalStorage > navigator.language > English
 */
function getLanguage(LANGUAGES){
    const browserLanguage = navigator.language.split("-")[0].toLowerCase();
    const supportedLanguagesCodes = LANGUAGES.map(pair => pair[0]);
    let language = localStorage.getItem("settings-language");

    // If nothing in localstorage, try to find what language navigator is using
    if (language === null || language === ""){
        if (supportedLanguagesCodes.includes(browserLanguage)) {
            language = browserLanguage;
        } else {
            // language not supported, set default to english
            language = "en";
        }
        localStorage.setItem("settings-language", language);
    }

    console.debug(`Language set to: ${language}`);

    $(".dropbtn4").val(language).trigger("change");
}

/**
 * Update every label with the correct localization text
 */
function updateContent() {
    document.querySelectorAll("[data-i18n], [data-i18n-placeholder], [data-i18n-title], [data-i18n-content], [data-i18n-label], [data-i18n-aria-label], [data-i18n-alt]").forEach(element => {
        if (element.hasAttribute("data-i18n")) {
            const rawKey = element.getAttribute("data-i18n");
            const [namespace, ...rest] = rawKey.split(":");
            const key = rest.join(":"); // in case ":" appears in the key
            element.textContent = i18next.t(key, { ns: namespace });
        }
    
        Array.from(element.attributes).forEach(attribute => {
            if (attribute.name.startsWith("data-i18n-")) {
                const rawKey = attribute.value;
                const attributeName = attribute.name.substring("data-i18n-".length);
                const [namespace, ...rest] = rawKey.split(":");
                const key = rest.join(":");
                const translatedValue = i18next.t(key, { ns: namespace });
                element.setAttribute(attributeName, translatedValue);
            }
        });
    });
}
