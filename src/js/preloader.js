// how long a failed image waits before the next try, here and for the images on screen: doubling from 1 s up to
// 10 s, so a deleted image does not cost every client a request per second for a whole round
const RETRY_MS = 1000;
const RETRY_MAX_MS = 10 * 1000;

export function retryDelay(failures) {
    return Math.min(RETRY_MS * 2 ** (failures - 1), RETRY_MAX_MS);
}

/**
 * Loads images ahead of time and keeps them referenced, so the <img> that shows them later gets them without a
 * request: the API sends max-age=0, and without a live reference Chrome would ask the server again
 */
export default class Preloader {
    constructor({
        createImage = () => new Image(),
        // wrapped: browsers throw "Illegal invocation" when setTimeout is called as a method of another object
        setTimer = (fn, ms) => setTimeout(fn, ms),
        clearTimer = (id) => clearTimeout(id),
    } = {}) {
        this.createImage = createImage;
        this.setTimer = setTimer;
        this.clearTimer = clearTimer;
        this.entries = new Map();
        this.queue = Promise.resolve();
    }

    /**
     * Loads the urls one after another (each starts after the previous one's first attempt, so they do not share
     * the bandwidth) and resolves once all of them loaded. A failed one is retried in the background (see retryDelay).
     * Asked for again without `low`, a low one waiting for its retry is tried at once.
     */
    load(urls, { low = false } = {}) {
        return Promise.all(urls.map((url) => {
            let entry = this.entries.get(url);
            if (!entry) {
                entry = { url, low, img: null, timer: null, dropped: false, failures: 0 };
                entry.loaded = new Promise((resolve) => { entry.resolve = resolve; });
                this.entries.set(url, entry);
                this.queue = this.queue.then(() => this.attempt(entry));
            }
            else if (!low && entry.low) {
                // the round now waits for it: its later attempts are no longer low priority, and one waiting out the
                // backoff of up to 10 s left over from the preload tries again at once, beside the queue
                entry.low = false;
                if (entry.timer !== null) {
                    this.clearTimer(entry.timer);
                    entry.failures = 0;
                    this.attempt(entry);
                }
            }
            return entry.loaded;
        }));
    }

    /**
     * Forgets every image but these: their retries stop and their downloads no longer count
     */
    keep(urls) {
        this.entries.forEach((entry, url) => {
            if (urls.includes(url)) return;
            entry.dropped = true;
            this.clearTimer(entry.timer);
            // a download that never answers (e.g. after a network switch) must not hold up the queue for good
            if (entry.settle) entry.settle();
            this.entries.delete(url);
        });
    }

    /**
     * One download attempt; resolves once it settled (loaded or failed) so the queue can move on
     */
    attempt(entry) {
        return new Promise((settled) => {
            entry.timer = null;
            if (entry.dropped) return settled();
            entry.settle = settled;
            const img = this.createImage();
            entry.img = img;
            // before src: the priority only applies to a download that has not started yet
            if (entry.low) img.fetchPriority = "low";
            img.onload = () => {
                if (!entry.dropped) entry.resolve();
                settled();
            };
            img.onerror = () => {
                settled();
                if (!entry.dropped) entry.timer = this.setTimer(() => this.attempt(entry), retryDelay(++entry.failures));
            };
            img.src = entry.url;
        });
    }
}
