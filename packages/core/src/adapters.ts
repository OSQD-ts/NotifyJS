import { Writable } from 'node:stream';
import type { Severity } from '@notifyjs/protocol';
import type { NotifyInput } from './server.js';

/**
 * Anything that can publish an alert: the embedded `Notifier` or a
 * `RemoteNotifier`. Adapters work against this so they do not care which
 * deployment shape you chose.
 */
export interface AlertSink {
  notify(input: NotifyInput | string): Promise<unknown>;
  call?(input: { message: string; severity?: Severity } | string): Promise<unknown>;
}

export interface CaptureOptions {
  channel?: string;
  /** Also ring a phone. Worth it for a crash that takes the process with it. */
  call?: boolean;
  /** Re-throw after alerting, preserving the default crash behaviour. */
  exit?: boolean;
  /** Milliseconds to let the alert reach the hub before the process ends. */
  drainMs?: number;
}

/**
 * Reports uncaught exceptions and unhandled rejections.
 *
 * A crash is the moment you most want to hear about and the moment the process
 * is least able to tell you, so the handler races a short drain window against
 * the exit. It is best-effort by nature - for the case where the process is
 * already gone, use a heartbeat instead.
 */
export function captureCrashes(sink: AlertSink, options: CaptureOptions = {}): () => void {
  const channel = options.channel ?? 'crash';
  const drainMs = options.drainMs ?? 1500;
  const shouldExit = options.exit ?? true;

  const report = async (kind: string, err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    const alert = {
      title: `${kind}: ${error.message}`.slice(0, 200),
      body: error.stack ?? String(error),
      channel,
      severity: 'critical' as const,
      // One crash loop should not become a thousand pages.
      dedupeKey: `${kind}:${error.message}`,
      requireAck: true,
    };

    try {
      await Promise.race([
        Promise.all([
          sink.notify(alert),
          options.call && sink.call
            ? sink.call({ message: `A service has crashed. ${error.message}`, severity: 'critical' })
            : undefined,
        ]),
        new Promise((resolve) => setTimeout(resolve, drainMs)),
      ]);
    } catch {
      // Nothing useful to do while the process is on its way out.
    }
  };

  const onException = (err: unknown) => {
    void report('Uncaught exception', err).finally(() => {
      // Node's default for an uncaught exception is to exit non-zero. Keeping
      // that means a supervisor still restarts the service.
      if (shouldExit) process.exit(1);
    });
  };

  const onRejection = (reason: unknown) => {
    void report('Unhandled rejection', reason);
  };

  process.on('uncaughtException', onException);
  process.on('unhandledRejection', onRejection);

  return () => {
    process.off('uncaughtException', onException);
    process.off('unhandledRejection', onRejection);
  };
}

export interface HttpErrorOptions {
  channel?: string;
  /** Statuses at or above this are reported. 4xx is usually noise. */
  minStatus?: number;
  severity?: Severity;
}

/**
 * Express/Connect error middleware. Mount it last:
 *
 *     app.use(expressErrorHandler(notify));
 */
export function expressErrorHandler(sink: AlertSink, options: HttpErrorOptions = {}) {
  const minStatus = options.minStatus ?? 500;

  return function notifyjsErrorHandler(
    err: Error & { status?: number; statusCode?: number },
    req: { method?: string; originalUrl?: string; url?: string },
    _res: unknown,
    next: (err?: unknown) => void,
  ): void {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= minStatus) {
      const route = `${req.method ?? 'GET'} ${req.originalUrl ?? req.url ?? '/'}`;
      void sink
        .notify({
          title: `${status} on ${route}`,
          body: err.stack ?? err.message,
          channel: options.channel ?? 'http',
          severity: options.severity ?? 'error',
          // Group by route and message, not by request.
          dedupeKey: `http:${route}:${err.message}`,
          data: { status, route },
        })
        .catch(() => {});
    }
    // Never swallow the error: the app's own handler still has to run.
    next(err);
  };
}

/** Fastify's error hook has a different shape but the same intent. */
export function fastifyErrorHandler(sink: AlertSink, options: HttpErrorOptions = {}) {
  const handler = expressErrorHandler(sink, options);
  return function notifyjsFastifyHook(
    err: Error & { statusCode?: number },
    request: { method?: string; url?: string },
    reply: { send(err: unknown): void },
  ): void {
    handler(err, request, reply, () => {});
    reply.send(err);
  };
}

/** Maps common logger level names and numeric levels onto severities. */
const LEVELS: Record<string, Severity> = {
  trace: 'debug',
  debug: 'debug',
  info: 'info',
  warn: 'warning',
  warning: 'warning',
  error: 'error',
  fatal: 'critical',
};

function severityForLevel(level: unknown): Severity | undefined {
  if (typeof level === 'string') return LEVELS[level.toLowerCase()];
  if (typeof level !== 'number') return undefined;
  // pino's numeric levels.
  if (level >= 60) return 'critical';
  if (level >= 50) return 'error';
  if (level >= 40) return 'warning';
  if (level >= 30) return 'info';
  return 'debug';
}

export interface LogStreamOptions {
  channel?: string;
  /** Only forward at or above this severity. Defaults to `error`. */
  minSeverity?: Severity;
}

const ORDER: Severity[] = ['debug', 'info', 'success', 'warning', 'error', 'critical'];

/**
 * A writable stream that turns log lines into alerts, for pino:
 *
 *     const logger = pino(createLogStream(notify));
 *
 * Only `error` and above are forwarded by default - a notification for every
 * info line would be a denial of service against the person carrying the
 * phone, and flood control should not have to be the thing that saves them.
 */
export function createLogStream(sink: AlertSink, options: LogStreamOptions = {}): Writable {
  const floor = ORDER.indexOf(options.minSeverity ?? 'error');

  return new Writable({
    write(chunk, _encoding, callback) {
      // A malformed line must never break the logger it is attached to.
      try {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          const record = JSON.parse(line) as Record<string, unknown>;
          const severity = severityForLevel(record.level);
          if (!severity || ORDER.indexOf(severity) < floor) continue;

          const message = String(record.msg ?? record.message ?? 'log event');
          void sink
            .notify({
              title: message.slice(0, 200),
              body: typeof record.stack === 'string' ? record.stack : undefined,
              channel: options.channel ?? String(record.name ?? 'log'),
              severity,
              dedupeKey: `log:${severity}:${message}`,
            })
            .catch(() => {});
        }
      } catch {
        // Not JSON, or not a shape we understand. Drop it silently.
      }
      callback();
    },
  });
}

/**
 * Adapter for loggers that hand you a structured record (winston transports,
 * bunyan streams). Wire it to whatever callback your logger exposes.
 */
export function logHandler(sink: AlertSink, options: LogStreamOptions = {}) {
  const floor = ORDER.indexOf(options.minSeverity ?? 'error');

  return function handleLogRecord(record: Record<string, unknown>): void {
    const severity = severityForLevel(record.level);
    if (!severity || ORDER.indexOf(severity) < floor) return;

    const message = String(record.message ?? record.msg ?? 'log event');
    void sink
      .notify({
        title: message.slice(0, 200),
        body: typeof record.stack === 'string' ? record.stack : undefined,
        channel: options.channel ?? 'log',
        severity,
        dedupeKey: `log:${severity}:${message}`,
      })
      .catch(() => {});
  };
}
