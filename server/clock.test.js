import { test } from "node:test";
import assert from "node:assert/strict";
import { updateOffset, secondsUntil } from "../src/js/clock.js";

test("updateOffset keeps the sample with the least latency", () => {
    // true offset +1000ms; samples arrive 300ms, 50ms and 500ms after the server stamped them
    let offset = updateOffset(null, 10000, 9300);
    assert.equal(offset, 700);
    offset = updateOffset(offset, 11000, 10050);
    assert.equal(offset, 950);
    offset = updateOffset(offset, 12000, 11500);
    assert.equal(offset, 950);
});

test("secondsUntil counts whole seconds down to a server time on the local clock, never below 0", () => {
    // the server clock is 2000ms ahead: server time 15000 is local 13000
    assert.equal(secondsUntil(15000, 2000, 10000), 3);
    assert.equal(secondsUntil(15000, 2000, 10001), 3);
    assert.equal(secondsUntil(15000, 2000, 12001), 1);
    assert.equal(secondsUntil(15000, 2000, 13000), 0);
    assert.equal(secondsUntil(15000, 2000, 20000), 0);
    // no message with a server time yet
    assert.equal(secondsUntil(15000, null, 10000), 5);
});
