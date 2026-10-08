import { test } from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { newImageId, packGuesses, unpackGuesses, zipFileName, isWebp, MAX_IMAGE, MAX_TOTAL } from "../src/js/guessPack.js";

const IMG = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
const URL_A = "/img/guesses/abcDEF123456789.webp";
const entry = (over = {}) => ({ map: "Sanxian", mode: "easy", url: URL_A, lat: -1166.9828731644454, lng: 859.1661270331499, ...over });

// what a hand-crafted ZIP can do: claim any unpacked size for an entry in its central directory
function declareSize(bytes, name, size) {
    const out = bytes.slice();
    const view = new DataView(out.buffer);
    for (let o = 0; o + 46 <= out.length; o++) {
        if (view.getUint32(o, true) !== 0x02014b50) continue;
        const length = view.getUint16(o + 28, true);
        if (strFromU8(out.subarray(o + 46, o + 46 + length)) === name) view.setUint32(o + 24, size, true);
    }
    return out;
}

// breaks the compressed data of one entry, so inflating it throws
function corrupt(bytes, name) {
    const out = bytes.slice();
    const view = new DataView(out.buffer);
    for (let o = 0; o + 30 <= out.length; o++) {
        if (view.getUint32(o, true) !== 0x04034b50) continue;
        const length = view.getUint16(o + 26, true);
        if (strFromU8(out.subarray(o + 30, o + 30 + length)) !== name) continue;
        // 0xff starts a deflate block of the reserved type 3
        out[o + 30 + length + view.getUint16(o + 28, true)] = 0xff;
    }
    return out;
}

// a ZIP as someone else's tool (or a hand-edited one) would build it
const zipOf = (list, images = { [URL_A.slice(1)]: IMG }, level = 0) =>
    zipSync({ "guesses.json": strToU8(JSON.stringify(list)), ...images }, { level });

test("packGuesses and unpackGuesses round-trip entries and image bytes", () => {
    const b = { entry: entry({ url: "/img/guesses/zzzZZZ999999999.webp", map: "Narva", submitter: "Dan" }), image: new Uint8Array([9, 8, 7]) };
    const items = unpackGuesses(packGuesses([{ entry: entry(), image: IMG }, b]));
    assert.deepEqual(items, [
        { entry: entry(), image: IMG, error: null },
        { entry: b.entry, image: b.image, error: null },
    ]);
});

test("packGuesses writes the README layout: fixed key order, 4 spaces, no empty submitter", () => {
    const shuffled = { lng: 2, submitter: "", lat: 1, url: URL_A, mode: "easy", map: "Narva", extra: true };
    const files = unzipSync(packGuesses([{ entry: shuffled, image: IMG }]));
    const json = strFromU8(files["guesses.json"]);
    assert.equal(json, JSON.stringify([{ map: "Narva", mode: "easy", url: URL_A, lat: 1, lng: 2 }], null, 4));
    assert.deepEqual(files[URL_A.slice(1)], IMG);
});

test("unpackGuesses marks broken entries with a reason and keeps their image when there is one", () => {
    const items = unpackGuesses(zipOf([
        entry({ map: "Atlantis" }),
        entry({ lat: NaN }),
        entry({ submitter: "x".repeat(41) }),
        entry({ mode: "medium" }),
        entry({ url: "/img/guesses/missing.webp" }),
        5,
        null,
        entry({ url: "/__proto__" }),
    ]));
    assert.deepEqual(items.map(i => i.error), [
        "invalid data", "invalid data", "invalid data", "invalid mode", "image missing", "invalid data", "invalid data", "invalid data",
    ]);
    assert.ok(items.every(i => i.entry === null));
    assert.deepEqual(items[3].image, IMG);
    assert.equal(items[4].image, null);
    assert.equal(items[5].image, null);
    // a url naming an Object.prototype key must not hand that object out as image bytes
    assert.equal(items[7].image, null);
});

test("unpackGuesses drops unknown fields", () => {
    const [item] = unpackGuesses(zipOf([{ ...entry(), evil: "<img src=x>", points: 100 }]));
    assert.deepEqual(item.entry, entry());
});

test("unpackGuesses only reads images under img/guesses/ and up to MAX_IMAGE", () => {
    const big = "img/guesses/big.webp";
    const items = unpackGuesses(zipOf(
        [entry({ url: "/img/other/abc.webp" }), entry({ url: `/${big}` }), entry({ url: "/img/guesses/anim.gif" })],
        { "img/other/abc.webp": IMG, [big]: new Uint8Array(MAX_IMAGE + 1), "img/guesses/anim.gif": IMG, "readme.txt": IMG },
    ));
    assert.deepEqual(items.map(i => i.error), ["image missing", "image missing", "image missing"]);
});

test("unpackGuesses reads PNG and JPEG images too, whatever the case of the extension", () => {
    const urls = ["/img/guesses/a.png", "/img/guesses/b.JPG", "/img/guesses/c.jpeg"];
    const items = unpackGuesses(zipOf(urls.map(url => entry({ url })), Object.fromEntries(urls.map(u => [u.slice(1), IMG]))));
    assert.deepEqual(items, urls.map(url => ({ entry: entry({ url }), image: IMG, error: null })));
});

test("packGuesses refuses two guesses that would share one image path", () => {
    assert.throws(() => packGuesses([{ entry: entry(), image: IMG }, { entry: entry({ map: "Narva" }), image: IMG }]), /duplicate image path img\/guesses\/abcDEF123456789\.webp/);
});

test("isWebp checks the RIFF/WEBP header", () => {
    const header = (tag) => new Uint8Array([...strToU8("RIFF"), 9, 9, 9, 9, ...strToU8(tag), 1, 2]);
    assert.equal(isWebp(header("WEBP")), true);
    assert.equal(isWebp(header("WAVE")), false);
    assert.equal(isWebp(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13])), false);
    assert.equal(isWebp(IMG), false);
});

test("unpackGuesses reads a ZIP that was packed again with compression", () => {
    const items = unpackGuesses(zipOf([entry()], undefined, 6));
    assert.deepEqual(items, [{ entry: entry(), image: IMG, error: null }]);
});

test("unpackGuesses rejects files it cannot use as a whole", () => {
    assert.throws(() => unpackGuesses(new Uint8Array([1, 2, 3])), /not a ZIP file/);
    assert.throws(() => unpackGuesses(zipSync({ "readme.txt": strToU8("[]") })), /no \.json file/);
    assert.throws(() => unpackGuesses(zipSync({ "a.json": strToU8("[]"), "b.json": strToU8("[]") })), /more than one \.json file: a\.json, b\.json/);
    assert.throws(() => unpackGuesses(zipSync({ "guesses.json": strToU8("nope{") })), /not valid JSON/);
    assert.throws(() => unpackGuesses(zipSync({ "guesses.json": strToU8("{\"a\":1}") })), /not a list/);
});

test("newImageId gives 15 letters or digits", () => {
    assert.equal(newImageId(b => b.fill(0)), "AAAAAAAAAAAAAAA");
    assert.equal(newImageId(b => b.fill(61)), "999999999999999");
    assert.equal(newImageId(b => b.fill(62)), "AAAAAAAAAAAAAAA");
    assert.match(newImageId(b => webcrypto.getRandomValues(b)), /^[A-Za-z0-9]{15}$/);
});

test("zipFileName keeps safe characters and falls back to anonymous", () => {
    const day = new Date(2026, 9, 6);
    assert.equal(zipFileName("Dan the Man!", day), "squadguessr-DantheMan-2026-10-06.zip");
    assert.equal(zipFileName("approved", day), "squadguessr-approved-2026-10-06.zip");
    assert.equal(zipFileName("  ", day), "squadguessr-anonymous-2026-10-06.zip");
    assert.equal(zipFileName("测试", day), "squadguessr-anonymous-2026-10-06.zip");
    assert.equal(zipFileName("a_b-c", new Date(2027, 0, 9)), "squadguessr-a_b-c-2027-01-09.zip");
});

test("unpackGuesses reads a ZIP whose files sit in one folder, as when the folder was compressed again", () => {
    const dir = "squadguessr-Dan-2026-10-06/";
    const bytes = zipSync({
        [`${dir}guesses.json`]: strToU8(JSON.stringify([entry()])),
        [`${dir}${URL_A.slice(1)}`]: IMG,
        // macOS adds these resource forks next to the real files
        [`__MACOSX/${dir}._guesses.json`]: IMG,
    }, { level: 6 });
    assert.deepEqual(unpackGuesses(bytes), [{ entry: entry(), image: IMG, error: null }]);
});

test("unpackGuesses takes the .json file whatever it is called and ignores the files macOS adds", () => {
    const bytes = zipSync({
        "my guesses.JSON": strToU8(JSON.stringify([entry()])),
        [URL_A.slice(1)]: IMG,
        "._my guesses.JSON": IMG,
        "__MACOSX/._my guesses.JSON": IMG,
    });
    assert.deepEqual(unpackGuesses(bytes), [{ entry: entry(), image: IMG, error: null }]);
});

test("unpackGuesses never inflates images no guess refers to", () => {
    const bytes = corrupt(zipSync({
        "g.json": strToU8(JSON.stringify([entry()])),
        [URL_A.slice(1)]: [IMG, { level: 0 }],
        "img/guesses/unused.webp": [new Uint8Array(1000), { level: 6 }],
    }), "img/guesses/unused.webp");
    assert.deepEqual(unpackGuesses(bytes), [{ entry: entry(), image: IMG, error: null }]);
});

test("unpackGuesses checks the real size of a stored image, not only the declared one", () => {
    const liar = "img/guesses/liar.webp";
    const bytes = declareSize(zipOf([entry({ url: `/${liar}` })], { [liar]: new Uint8Array(MAX_IMAGE + 1) }), liar, 10);
    assert.deepEqual(unpackGuesses(bytes).map(i => i.error), ["image missing"]);
});

test("unpackGuesses rejects a ZIP whose images would unpack to more than MAX_TOTAL", () => {
    const urls = Array.from({ length: Math.floor(MAX_TOTAL / MAX_IMAGE) + 1 }, (_, i) => `/img/guesses/big${i}.webp`);
    let bytes = zipOf(urls.map(url => entry({ url })), Object.fromEntries(urls.map(u => [u.slice(1), IMG])));
    urls.forEach(u => { bytes = declareSize(bytes, u.slice(1), MAX_IMAGE); });
    assert.throws(() => unpackGuesses(bytes), /too large/);
});

test("unpackGuesses writes the map name the way the map list spells it", () => {
    const items = unpackGuesses(zipOf(
        [entry({ map: "tallil" }), entry({ map: "ALBASRAH", url: "/img/guesses/b.webp" })],
        { [URL_A.slice(1)]: IMG, "img/guesses/b.webp": IMG },
    ));
    assert.deepEqual(items.map(i => i.entry.map), ["Tallil", "AlBasrah"]);
});
