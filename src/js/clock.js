/**
 * Estimate of (server clock - local clock) from one more message
 * serverNow - receivedAt is the true offset minus the message's travel time, so the largest sample is the most accurate.
 */
export function updateOffset(current, serverNow, receivedAt) {
    const sample = serverNow - receivedAt;
    return current === null ? sample : Math.max(current, sample);
}

/**
 * Whole seconds left until a server time (e.g. a deadline), as the local clock sees it; never below 0
 */
export function secondsUntil(at, offset, now) {
    return Math.max(0, Math.ceil((at - now - (offset ?? 0)) / 1000));
}
