import type { CallOutcome, Severity } from '@osqd/notifyjs-protocol';

/**
 * Counters for a hub you self-host and then forget about.
 *
 * Rendered in Prometheus text format so it drops into whatever is already
 * scraping your machines. Deliberately counts only - no titles, channels or
 * device names - so exposing `/metrics` cannot leak the content of an alert.
 */
export class Metrics {
  readonly startedAt = Date.now();

  private notifications = new Map<Severity, number>();
  private delivered = 0;
  private coalesced = 0;
  private summaries = 0;
  private callsPlaced = 0;
  private callOutcomes = new Map<CallOutcome, number>();
  private authFailures = 0;
  private bans = 0;
  private pushSent = 0;
  private pushFailed = 0;
  private stalledDrops = 0;
  private heartbeatMisses = 0;

  notified(severity: Severity, reached: number): void {
    this.notifications.set(severity, (this.notifications.get(severity) ?? 0) + 1);
    this.delivered += reached;
  }

  coalescedOne(): void {
    this.coalesced += 1;
  }

  summarised(): void {
    this.summaries += 1;
  }

  callPlaced(): void {
    this.callsPlaced += 1;
  }

  callOutcome(outcome: CallOutcome): void {
    this.callOutcomes.set(outcome, (this.callOutcomes.get(outcome) ?? 0) + 1);
  }

  authFailed(): void {
    this.authFailures += 1;
  }

  banned(): void {
    this.bans += 1;
  }

  pushed(ok: boolean): void {
    if (ok) this.pushSent += 1;
    else this.pushFailed += 1;
  }

  stalled(): void {
    this.stalledDrops += 1;
  }

  heartbeatMissed(): void {
    this.heartbeatMisses += 1;
  }

  /** Live gauges are read at scrape time rather than tracked incrementally. */
  render(gauges: {
    devices: number;
    devicesOnline: number;
    sessions: number;
    heartbeats: number;
    heartbeatsMissing: number;
    activeCalls: number;
  }): string {
    const lines: string[] = [];

    const metric = (name: string, help: string, type: string, value: number, labels = '') => {
      lines.push(`# HELP notifyjs_${name} ${help}`);
      lines.push(`# TYPE notifyjs_${name} ${type}`);
      lines.push(`notifyjs_${name}${labels} ${value}`);
    };

    lines.push('# HELP notifyjs_notifications_total Notifications published, by severity.');
    lines.push('# TYPE notifyjs_notifications_total counter');
    for (const [severity, count] of this.notifications) {
      lines.push(`notifyjs_notifications_total{severity="${severity}"} ${count}`);
    }

    lines.push('# HELP notifyjs_calls_total Calls that reached an outcome.');
    lines.push('# TYPE notifyjs_calls_total counter');
    for (const [outcome, count] of this.callOutcomes) {
      lines.push(`notifyjs_calls_total{outcome="${outcome}"} ${count}`);
    }

    metric('deliveries_total', 'Notification deliveries to a device.', 'counter', this.delivered);
    metric('coalesced_total', 'Notifications held back by flood control.', 'counter', this.coalesced);
    metric('summaries_total', 'Summaries emitted after a flood window.', 'counter', this.summaries);
    metric('calls_placed_total', 'Calls placed.', 'counter', this.callsPlaced);
    metric('auth_failures_total', 'Failed pair or auth attempts.', 'counter', this.authFailures);
    metric('bans_total', 'IP bans issued.', 'counter', this.bans);
    metric('push_sent_total', 'Wake-up pushes delivered.', 'counter', this.pushSent);
    metric('push_failed_total', 'Wake-up pushes that failed.', 'counter', this.pushFailed);
    metric('stalled_drops_total', 'Devices dropped for not reading.', 'counter', this.stalledDrops);
    metric('heartbeat_misses_total', 'Heartbeat check-ins missed.', 'counter', this.heartbeatMisses);

    metric('devices', 'Devices known to the hub.', 'gauge', gauges.devices);
    metric('devices_online', 'Devices currently connected.', 'gauge', gauges.devicesOnline);
    metric('sessions', 'Open WebSocket sessions.', 'gauge', gauges.sessions);
    metric('heartbeats', 'Registered heartbeats.', 'gauge', gauges.heartbeats);
    metric('heartbeats_missing', 'Heartbeats currently overdue.', 'gauge', gauges.heartbeatsMissing);
    metric('active_calls', 'Calls ringing right now.', 'gauge', gauges.activeCalls);
    metric(
      'uptime_seconds',
      'Seconds since the hub started.',
      'gauge',
      Math.floor((Date.now() - this.startedAt) / 1000),
    );

    return lines.join('\n') + '\n';
  }
}
