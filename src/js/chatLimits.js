// Chat limits, shared by the server (server/session.js) and the client (multiplayer.js)

// characters per line, counted as seen: a flag or a family emoji is one
export const CHAT_MAX = 200;
// the pause the client leaves between two lines of a player; the server allows half of it, the rest is network jitter
export const CHAT_GAP_MS = 1000;
// lines a newcomer gets to read, and lines kept on screen
export const CHAT_HISTORY = 50;
