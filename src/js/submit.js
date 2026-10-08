import i18next from "i18next";
import { MAPS, findMap } from "./data/maps.js";
import { squadMinimap } from "./squadMinimap.js";
import { guessMarker } from "./guessMarker.js";
import { newImageId, packGuesses, zipFileName, downloadZip } from "./guessPack.js";
import { IMAGE_SIZE, centredSquare, squareWebp } from "./webp.js";

// share of the long image side the square moves per arrow key press
const KEY_STEP = 0.02;
// zoom when a guess from the list is opened: close enough to see where its marker sits
const EDIT_ZOOM = 4;

/**
 * "Submit a guess" view (?submit): paste a screenshot, choose its square, pin where it was taken
 * and download everything as one ZIP for Discord
 */
export default class Submit {
    constructor(app) {
        this.app = app;
        this.minimap = null;
        this.map = null;
        this.marker = null;
        this.bitmap = null;
        this.crop = null;
        this.previewUrl = null;
        this.file = null;
        // counts image loads: only the latest one may land in the editor
        this.loads = 0;
        this.drag = null;
        this.adding = false;
        this.guesses = [];
        // index of the guess being corrected, null while a new one is prepared
        this.editing = null;
        this.dirty = false;
    }

    init() {
        MAPS.forEach(m => $("#submitMapSelect").append($("<option>").val(m.name).text(m.name)));

        // the menu entry offers submitting and reviewing; Review opens itself from its own button
        $("#BUTTON_SUBMIT").on("click", () => $("#submitChoice").prop("hidden", (i, hidden) => !hidden));
        $("#submitChoice button").on("click", () => $("#submitChoice").prop("hidden", true));
        $("#BUTTON_SUBMIT_GO").on("click", () => this.open());
        $("#BUTTON_SUBMIT_BACK").on("click", () => this.app.toMenu());
        $("#submitMapSelect").on("change", (e) => this.selectMap(e.target.value));
        $("#BUTTON_SUBMIT_ADD").on("click", () => this.add());
        $("#BUTTON_SUBMIT_CANCEL").on("click", () => this.cancelEdit());
        $("#BUTTON_SUBMIT_DOWNLOAD").on("click", () => this.download());
        $("#submitFile").on("change", (e) => {
            if (e.target.files[0]) this.loadImage(e.target.files[0]);
            // choosing the same file again must fire change again
            e.target.value = "";
        });
        this.setupImageArea();

        document.addEventListener("paste", (e) => {
            if (!$("#submit").is(":visible")) return;
            const file = Array.from(e.clipboardData?.files ?? []).find(f => f.type.startsWith("image/"));
            if (!file) return;
            e.preventDefault();
            this.loadImage(file);
        });
        this.app.warnOnLeave(() => this.dirty && this.guesses.length > 0);
        // labels written here (DOWNLOAD count, ✕) are not covered by data-i18n
        i18next.on("languageChanged", () => this.renderList());
        this.updateButtons();

        if (new URLSearchParams(location.search).has("submit")) this.open();
    }

    open() {
        history.replaceState({}, "", "/?submit");
        this.app.switchUI("submit");
        // leaflet measures its container: create the map once the view is shown
        if (!this.minimap) {
            this.minimap = new squadMinimap("submitMinimap", this.app.MAPSIZE, MAPS[0]);
            // the game's handlers look at the game's state (solution marker, mode): this view places its own marker
            this.minimap._handleclick = (e) => this.placeMarker(e.latlng);
            this.minimap._handleDoubleClick = (e) => this.placeMarker(e.latlng);
        }
        this.minimap.invalidateSize();
    }

    setupImageArea() {
        const area = document.getElementById("submitImage");

        area.addEventListener("click", () => {
            if (!this.bitmap) $("#submitFile").trigger("click");
        });
        $("#BUTTON_SUBMIT_CLEAR_IMAGE")
            // the image area underneath would start dragging the square, and its click would open the file picker
            .on("pointerdown", (e) => e.stopPropagation())
            .on("click", (e) => {
                e.stopPropagation();
                this.clearImage();
                this.updateButtons();
            });
        // a file dropped anywhere on the page (header and footer included) would otherwise make the browser leave it
        $(document).on("dragover", (e) => {
            if ($("#submit").is(":visible")) e.preventDefault();
        });
        $(document).on("drop", (e) => {
            if (!$("#submit").is(":visible")) return;
            e.preventDefault();
            const file = Array.from(e.originalEvent.dataTransfer.files).find(f => f.type.startsWith("image/"));
            if (file) this.loadImage(file);
        });

        area.addEventListener("keydown", (e) => {
            const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (!dir || !this.bitmap) return;
            e.preventDefault();
            const step = KEY_STEP * Math.max(this.bitmap.width, this.bitmap.height);
            this.moveCrop(this.crop.sx + dir[0] * step, this.crop.sy + dir[1] * step);
        });

        area.addEventListener("pointerdown", (e) => {
            if (!this.bitmap) return;
            area.setPointerCapture(e.pointerId);
            this.drag = { x: e.clientX, y: e.clientY, sx: this.crop.sx, sy: this.crop.sy };
        });
        area.addEventListener("pointermove", (e) => {
            if (!this.drag) return;
            // screen pixels to image pixels
            const scale = this.bitmap.width / document.getElementById("submitPreview").clientWidth;
            this.moveCrop(this.drag.sx + (e.clientX - this.drag.x) * scale, this.drag.sy + (e.clientY - this.drag.y) * scale);
        });
        const endDrag = () => { this.drag = null; };
        area.addEventListener("pointerup", endDrag);
        area.addEventListener("pointercancel", endDrag);
    }

    async loadImage(file) {
        // clicking through the list quickly must not end with an older, slower image in the editor
        const load = ++this.loads;
        let bitmap;
        try {
            bitmap = await createImageBitmap(file);
        } catch {
            if (load === this.loads) this.toast("submit.errors.notImage");
            return;
        }
        if (load !== this.loads) return bitmap.close();
        const { width, height } = bitmap;
        if (Math.min(width, height) < IMAGE_SIZE) {
            bitmap.close();
            return this.toast("submit.errors.tooSmall", { width, height });
        }
        this.clearImage();
        this.bitmap = bitmap;
        // kept with the guess so its square can be changed later
        this.file = file;
        this.crop = centredSquare(bitmap);
        this.previewUrl = URL.createObjectURL(file);
        $("#submitPreview").attr("src", this.previewUrl);
        $(".submit-crop").css("--ratio", String(width / height));
        $("#submitImage").addClass("loaded");
        this.moveCrop(this.crop.sx, this.crop.sy);
        this.updateButtons();
    }

    clearImage() {
        // an image still decoding must not show up after this
        this.loads++;
        this.bitmap?.close();
        this.bitmap = null;
        this.file = null;
        this.drag = null;
        if (this.previewUrl) URL.revokeObjectURL(this.previewUrl);
        this.previewUrl = null;
        $("#submitPreview").removeAttr("src");
        $("#submitImage").removeClass("loaded");
    }

    /**
     * Moves the square to the given top left corner (image pixels), kept inside the image
     */
    moveCrop(sx, sy) {
        const { width, height } = this.bitmap;
        const size = this.crop.size;
        this.crop.sx = Math.min(Math.max(sx, 0), width - size);
        this.crop.sy = Math.min(Math.max(sy, 0), height - size);
        $("#submitFrame").css({
            left: `${this.crop.sx / width * 100}%`,
            top: `${this.crop.sy / height * 100}%`,
            width: `${size / width * 100}%`,
            height: `${size / height * 100}%`,
        });
    }

    selectMap(name) {
        this.map = findMap(name) ?? null;
        // the old marker's coordinates mean nothing on another map
        this.minimap.clear();
        this.marker = null;
        this.minimap.activeMap = this.map;
        this.minimap.draw();
        this.updateButtons();
    }

    placeMarker(latlng) {
        if (!this.map || !this.minimap.imageBounds.contains(latlng)) return;
        if (this.marker) this.marker.setLatLng(latlng);
        else this.marker = new guessMarker(latlng, {}, this.minimap).addTo(this.minimap.markersGroup);
        this.updateButtons();
    }

    async add() {
        if (this.adding) return;
        this.adding = true;
        this.updateButtons();
        // read everything before the await: the map, the marker or the image may change while the webp is encoded
        const { lat, lng } = this.marker.getLatLng();
        const scale = this.minimap.mapToGameScale;
        const editing = this.editing;
        // a corrected guess keeps its image name; the same numbers the debug helper logLatLng prints for this spot
        const url = editing === null ? `/img/guesses/${newImageId()}.webp` : this.guesses[editing].entry.url;
        const entry = { map: this.map.name, mode: "easy", url, lat: lat * scale, lng: lng * scale };
        const file = this.file;
        const crop = { ...this.crop };
        // an image pasted while the webp is encoded starts a newer load: it stays in the editor afterwards
        const load = this.loads;
        let blob;
        try {
            blob = await squareWebp(this.bitmap, this.crop);
        } finally {
            this.adding = false;
        }
        if (!blob) {
            this.updateButtons();
            return this.toast("submit.errors.noWebp");
        }
        const guess = { entry, blob, thumb: URL.createObjectURL(blob), file, crop };
        if (editing === null) {
            this.guesses.push(guess);
        } else {
            URL.revokeObjectURL(this.guesses[editing].thumb);
            this.guesses[editing] = guess;
            this.editing = null;
        }
        this.dirty = true;
        if (this.loads === load) this.clearImage();
        this.marker?.remove();
        this.marker = null;
        this.renderList();
    }

    /**
     * Loads a guess from the list back into the editor: map, marker, original image and its square
     */
    async edit(index) {
        // the list stays put while a guess is being saved: its index is taken before the webp is encoded
        if (this.adding) return;
        const g = this.guesses[index];
        this.editing = index;
        $("#submitMapSelect").val(g.entry.map);
        // the map already shown stays: no reload of the basemap
        if (this.map?.name === g.entry.map) {
            this.marker?.remove();
            this.marker = null;
        } else {
            this.selectMap(g.entry.map);
        }
        const scale = this.minimap.gameToMapScale;
        const latlng = { lat: g.entry.lat * scale, lng: g.entry.lng * scale };
        this.placeMarker(latlng);
        this.minimap.setView(latlng, EDIT_ZOOM);
        this.renderList();
        await this.loadImage(g.file);
        // another guess (or image) may have been chosen while this one was decoding
        if (this.editing === index && this.file === g.file) this.moveCrop(g.crop.sx, g.crop.sy);
    }

    cancelEdit() {
        if (this.adding) return;
        this.editing = null;
        this.clearImage();
        this.marker?.remove();
        this.marker = null;
        this.renderList();
    }

    remove(index) {
        if (this.adding) return;
        // indexes shift and the edited guess may be the one going away
        if (this.editing !== null) this.cancelEdit();
        URL.revokeObjectURL(this.guesses[index].thumb);
        this.guesses.splice(index, 1);
        this.dirty = true;
        this.renderList();
    }

    renderList() {
        const $list = $("#submitList").empty();
        this.guesses.forEach((g, index) => {
            $("<li>").toggleClass("editing", index === this.editing).append(
                $("<button>").addClass("submit-edit").attr("title", i18next.t("submit.edit", { ns: "common" })).append(
                    $("<img>").attr({ src: g.thumb, alt: "" }),
                    $("<span>").text(g.entry.map),
                ).on("click", () => this.edit(index)),
                $("<button>").attr("aria-label", i18next.t("submit.remove", { ns: "common" })).text("✕").on("click", () => this.remove(index)),
            ).appendTo($list);
        });
        this.updateButtons();
    }

    updateButtons() {
        const editing = this.editing !== null;
        $("#BUTTON_SUBMIT_ADD")
            .text(i18next.t(editing ? "submit.buttons.save" : "submit.buttons.add", { ns: "common" }))
            .prop("disabled", this.adding || !(this.map && this.bitmap && this.marker));
        $("#BUTTON_SUBMIT_CANCEL").prop("hidden", !editing);
        $("#BUTTON_SUBMIT_DOWNLOAD")
            .text(`${i18next.t("submit.buttons.download", { ns: "common" })} (${this.guesses.length})`)
            .prop("disabled", !this.guesses.length);
    }

    async download() {
        // the name is read only now and goes into every guess of this ZIP
        const name = $("#submitName").val().trim();
        const items = await Promise.all(this.guesses.map(async g => ({
            entry: { ...g.entry, submitter: name },
            image: new Uint8Array(await g.blob.arrayBuffer()),
        })));
        downloadZip(packGuesses(items), zipFileName(name));
        this.dirty = false;
    }

    toast(key, values = {}) {
        this.app.openToast("error", i18next.t(key, { ns: "common", ...values }), "");
    }
}
