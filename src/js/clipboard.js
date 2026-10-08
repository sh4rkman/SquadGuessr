/**
 * Copy text to the clipboard. The Clipboard API exists only in a secure context (https, localhost) and may still be
 * refused there (page not focused, permission denied): then the old copy command does it, which also works on plain http
 */
export function copyText(text) {
    if (!navigator.clipboard) return execCopy(text);
    return navigator.clipboard.writeText(text).catch(() => execCopy(text));
}

function execCopy(text) {
    const area = document.createElement("textarea");
    area.value = text;
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied ? Promise.resolve() : Promise.reject(new Error("copy command failed"));
}
