import { ConsoleLogger, LogLevel, LoggerService } from '@nestjs/common';

import { currentLogContext } from './log-context';

/**
 * One JSON object per line, correlated to the request that produced it.
 *
 * Nest's default logger is designed to be read by a person watching a terminal.
 * In production nobody watches a terminal — the lines go to CloudWatch, Loki or
 * Datadog, where a human-friendly format is the problem rather than the
 * feature: you cannot filter `workspace_id = X` out of a coloured string, and
 * the timestamp is the only field a collector can reliably parse.
 *
 * So: pretty output in development, JSON in production, chosen by `LOG_FORMAT`
 * with the environment as the default. The correlation fields come from
 * AsyncLocalStorage, which is what lets an ordinary `this.logger.warn(...)` deep
 * inside a service carry the request id without being handed one.
 */
export class JsonLogger implements LoggerService {
  private readonly levels: Set<LogLevel>;

  constructor(levels: LogLevel[]) {
    this.levels = new Set(levels);
  }

  /**
   * Builds the logger the environment asks for.
   *
   * `LOG_FORMAT=json|pretty` wins; otherwise anything that is not development
   * gets JSON, because a deployed process is being read by a machine.
   */
  static create(env: NodeJS.ProcessEnv = process.env): LoggerService {
    const levels = parseLevels(env.LOG_LEVEL);
    const format = env.LOG_FORMAT ?? (env.NODE_ENV === 'development' ? 'pretty' : 'json');

    if (format === 'pretty') {
      const logger = new ConsoleLogger();
      logger.setLogLevels(levels);
      return logger;
    }

    return new JsonLogger(levels);
  }

  log(message: unknown, context?: string): void {
    this.write('info', message, context);
  }

  error(message: unknown, stack?: string, context?: string): void {
    this.write('error', message, context, stack);
  }

  warn(message: unknown, context?: string): void {
    this.write('warn', message, context);
  }

  debug(message: unknown, context?: string): void {
    this.write('debug', message, context);
  }

  verbose(message: unknown, context?: string): void {
    this.write('verbose', message, context);
  }

  private write(level: LogLevel | 'info', message: unknown, context?: string, stack?: string) {
    const nestLevel = level === 'info' ? 'log' : level;
    if (!this.levels.has(nestLevel as LogLevel)) return;

    const correlation = currentLogContext();

    const line: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      context,
      // An object passed as the message becomes fields rather than "[object
      // Object]" — the failure that makes structured logging worse than none.
      ...(typeof message === 'object' && message !== null
        ? (message as Record<string, unknown>)
        : { message: String(message) }),
      ...(correlation
        ? {
            request_id: correlation.requestId,
            workspace_id: correlation.workspaceId ?? undefined,
            org_id: correlation.orgId ?? undefined,
            user_id: correlation.userId ?? undefined,
            api_key_id: correlation.apiKeyId ?? undefined,
          }
        : {}),
      ...(stack ? { stack } : {}),
    };

    for (const key of Object.keys(line)) {
      if (line[key] === undefined) delete line[key];
    }

    // Written to the same stream Nest uses, so ordering relative to anything
    // that bypasses this logger is preserved.
    const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    stream.write(`${safeStringify(line)}\n`);
  }
}

const ALL_LEVELS: LogLevel[] = ['error', 'warn', 'log', 'debug', 'verbose'];

/** `LOG_LEVEL` names the *lowest* level to emit, as everything else does. */
function parseLevels(raw: string | undefined): LogLevel[] {
  const wanted = (raw ?? 'log').toLowerCase();
  const index = ALL_LEVELS.indexOf(wanted as LogLevel);
  return index === -1 ? ALL_LEVELS.slice(0, 3) : ALL_LEVELS.slice(0, index + 1);
}

/**
 * A circular reference in a logged object must not take the process down. One
 * unserialisable log line is a nuisance; an unhandled throw inside the logger
 * is an outage caused by logging.
 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return JSON.stringify({
      time: new Date().toISOString(),
      level: 'error',
      message: 'Log line could not be serialised.',
    });
  }
}
