const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
function initialLevel() {
    const fromEnv = process.env.CHATGPT_DESKTOP_MCP_LOG?.trim();
    return fromEnv && fromEnv in LEVELS ? fromEnv : 'info';
}
let currentLevel = initialLevel();
export function setLogLevel(level) {
    currentLevel = level;
}
function write(level, message, fields) {
    if (LEVELS[level] > LEVELS[currentLevel])
        return;
    const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    // stdout is reserved for MCP traffic in stdio mode, so all logs go to stderr.
    process.stderr.write(`[chatgpt-desktop-mcp] ${level}: ${message}${suffix}\n`);
}
export const log = {
    error: (message, fields) => write('error', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    info: (message, fields) => write('info', message, fields),
    debug: (message, fields) => write('debug', message, fields),
};
