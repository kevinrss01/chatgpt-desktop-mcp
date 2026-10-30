export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function asString(value) {
    return typeof value === 'string' && value.length > 0 ? value : null;
}
export function asArray(value) {
    if (Array.isArray(value))
        return value;
    if (isRecord(value))
        return Object.values(value);
    return [];
}
export function truncate(text, maxChars) {
    if (text.length <= maxChars)
        return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
/** Converts app-server timestamps (seconds or milliseconds) to ISO strings. */
export function toIsoTime(value) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        return null;
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
}
export function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
/** An error whose message is safe and useful to show to the MCP caller. */
export class BridgeError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'BridgeError';
    }
}
export function errorMessage(error) {
    if (error instanceof Error)
        return error.message;
    return String(error);
}
