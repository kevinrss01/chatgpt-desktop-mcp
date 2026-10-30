const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 } as const;

export type LogLevel = keyof typeof LEVELS;

function initialLevel(): LogLevel {
  const fromEnv = process.env.CHATGPT_DESKTOP_MCP_LOG?.trim();
  return fromEnv && fromEnv in LEVELS ? (fromEnv as LogLevel) : 'info';
}

let currentLevel: LogLevel = initialLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (LEVELS[level] > LEVELS[currentLevel]) return;
  const suffix = fields && Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
  // stdout is reserved for MCP traffic in stdio mode, so all logs go to stderr.
  process.stderr.write(`[chatgpt-desktop-mcp] ${level}: ${message}${suffix}\n`);
}

export const log = {
  error: (message: string, fields?: Record<string, unknown>) => write('error', message, fields),
  warn: (message: string, fields?: Record<string, unknown>) => write('warn', message, fields),
  info: (message: string, fields?: Record<string, unknown>) => write('info', message, fields),
  debug: (message: string, fields?: Record<string, unknown>) => write('debug', message, fields),
};
