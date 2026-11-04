import { test } from "node:test";
import assert from "node:assert/strict";
import Preloader, { retryDelay } from "../src/js/preloader.js";

// fake images record each download attempt when their src is set; fake timers fire on demand
function setup() {
    const images = [];
    const timers = [];
    const preloader = new Preloader({
        createImage: () => ({
            set src(url) {
                this.url = url;
                this.priorityAtStart = this.fetchPriority;
                images.push(this);
            },
        }),
        setTimer: (fn, ms) => timers.push({ fn, ms, cleared: false }) - 1,
        clearTimer: (id) => { if (timers[id]) timers[id].cleared = true; },
    });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    const fire = () => timers.splice(0).filter(t => !t.cleared).forEach(t => t.fn());
    return { preloader, images, timers, flush, fire };
}

test("resolves once the image loaded, and the same url is not downloaded twice", async () => {
    const { preloader, images, flush } = setup();
    let done = false;
    preloader.load(["/a"]).then(() => { done = true; });
    await flush();
    assert.equal(done, false);
    images[0].onload();
    await flush();
    assert.equal(done, true);
    await preloader.load(["/a"]);
    assert.equal(images.length, 1);
});

test("a failed image is retried after 1 s, 2 s, 4 s ... (at most 10 s) and only counts once it loads", async () => {
    const { preloader, images, timers, flush, fire } = setup();
    assert.deepEqual([1, 2, 3, 4, 5, 20].map(retryDelay), [1000, 2000, 4000, 8000, 10000, 10000]);
    let done = false;
    preloader.load(["/a"]).then(() => { done = true; });
    await flush();
    images[0].onerror();
    assert.equal(timers[0].ms, 1000);
    fire();
    images[1].onerror();
    assert.equal(timers[0].ms, 2000);
    fire();
    await flush();
    assert.equal(done, false);
    images[2].onload();
    await flush();
    assert.equal(done, true);
});

test("images load one after another, and one that keeps failing does not hold up the next", async () => {
    const { preloader, images, flush } = setup();
    preloader.load(["/hint", "/map"]);
    await flush();
    assert.deepEqual(images.map(i => i.url), ["/hint"]);
    images[0].onerror();
    await flush();
    assert.deepEqual(images.map(i => i.url), ["/hint", "/map"]);
});

test("low priority is set before the download starts", async () => {
    const { preloader, images, flush } = setup();
    preloader.load(["/next"], { low: true });
    await flush();
    images[0].onload();
    preloader.load(["/now"]);
    await flush();
    assert.deepEqual(images.map(i => i.priorityAtStart), ["low", undefined]);
});

test("keep drops every other image: no more retries, a download that never answers stops holding up the queue, a late load no longer counts", async () => {
    const { preloader, images, flush, fire } = setup();
    let failedDone = false;
    let hangingDone = false;
    preloader.load(["/failed"]).then(() => { failedDone = true; });
    await flush();
    images[0].onerror();
    preloader.load(["/hangs"]).then(() => { hangingDone = true; });
    preloader.load(["/kept"]);
    await flush();
    preloader.keep(["/kept"]);
    fire();
    await flush();
    assert.deepEqual(images.map(i => i.url), ["/failed", "/hangs", "/kept"]);
    images[1].onload();
    await flush();
    assert.deepEqual([failedDone, hangingDone], [false, false]);
});

test("an urgent load of an image waiting for its retry tries again at once, at normal priority, with the backoff reset", async () => {
    const { preloader, images, timers, flush, fire } = setup();
    let done = false;
    preloader.load(["/next"], { low: true }).then(() => { done = true; });
    await flush();
    images[0].onerror();
    fire();
    images[1].onerror();
    assert.equal(timers[0].ms, 2000);
    preloader.load(["/next"]);
    assert.equal(timers[0].cleared, true);
    assert.deepEqual(images.map(i => i.priorityAtStart), ["low", "low", undefined]);
    images[2].onerror();
    assert.equal(timers[1].ms, 1000);
    images[2].onload();
    await flush();
    assert.equal(done, true);
});

test("only the first urgent load cuts the backoff short: asked for again, an urgent image keeps waiting", async () => {
    const { preloader, images, timers, flush } = setup();
    preloader.load(["/next"], { low: true });
    await flush();
    images[0].onerror();
    preloader.load(["/next"]);
    images[1].onerror();
    preloader.load(["/next"]);
    assert.equal(images.length, 2);
    assert.equal(timers.at(-1).cleared, false);
});

test("a queued low image starts at normal priority once it is asked for urgently", async () => {
    const { preloader, images, flush } = setup();
    preloader.load(["/now"]);
    preloader.load(["/next"], { low: true });
    preloader.load(["/next"]);
    await flush();
    images[0].onload();
    await flush();
    assert.deepEqual(images.map(i => i.priorityAtStart), [undefined, undefined]);
});
