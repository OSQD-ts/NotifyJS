import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { SourceState } from '@osqd/notifyjs-protocol';
import type { FeedEntry } from './useSources';
import { SEVERITY_COLORS, useTheme } from './theme';

interface Props {
  feed: FeedEntry[];
  sources: SourceState[];
  snoozedUntil: number;
  onRefresh(): void;
  onSnooze(): void;
  onOpenSettings(): void;
}

export function FeedScreen({
  feed,
  sources,
  snoozedUntil,
  onRefresh,
  onSnooze,
  onOpenSettings,
}: Props) {
  const t = useTheme();
  const snoozing = snoozedUntil > Date.now();

  const enabled = sources.filter((s) => s.enabled);
  const connected = enabled.filter((s) => s.status === 'ready').length;
  const down = sources.filter((s) => s.serviceDown);

  // With several hubs, a single status word would hide which one is unhappy.
  const summary =
    sources.length === 0
      ? 'no sources'
      : `${connected}/${enabled.length} connected`;

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <View style={[styles.header, { borderColor: t.border, backgroundColor: t.surface }]}>
        <View style={styles.headerText}>
          <Text style={[styles.hub, { color: t.text }]}>NotifyJS</Text>
          <Text style={[styles.role, { color: t.muted }]}>{summary}</Text>
        </View>
        <View style={styles.headerRight}>
          <View
            style={[
              styles.dot,
              {
                backgroundColor:
                  down.length > 0
                    ? SEVERITY_COLORS.critical
                    : connected === enabled.length && enabled.length > 0
                      ? SEVERITY_COLORS.success
                      : t.muted,
              },
            ]}
          />
          <TouchableOpacity
            onPress={onSnooze}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={snoozing ? 'Resume notifications' : 'Snooze for 30 minutes'}
          >
            <Text style={[styles.unpair, { color: snoozing ? t.accent : t.muted }]}>
              {snoozing ? 'Snoozed' : 'Snooze'}
            </Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onOpenSettings} hitSlop={10} accessibilityRole="button">
            <Text style={[styles.unpair, { color: t.muted }]}>Settings</Text>
          </TouchableOpacity>
        </View>
      </View>

      {down.map((source) => (
        <View
          key={source.id}
          style={[styles.serviceDown, { backgroundColor: t.surface, borderColor: SEVERITY_COLORS.critical }]}
          accessibilityRole="alert"
        >
          <Text style={[styles.serviceDownTitle, { color: SEVERITY_COLORS.critical }]}>
            {source.serviceDown?.title}
          </Text>
          {source.serviceDown?.body ? (
            <Text style={[styles.serviceDownBody, { color: t.muted }]}>{source.serviceDown.body}</Text>
          ) : null}
        </View>
      ))}

      <FlatList
        data={feed}
        keyExtractor={(e) => `${e.sourceId}:${e.notification.id}`}
        contentContainerStyle={feed.length === 0 ? styles.emptyWrap : styles.list}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={t.muted} />
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: t.muted }]}>
            {sources.length === 0
              ? 'No sources yet. Open Settings to add one.'
              : 'Nothing yet. Alerts from your hubs will appear here.'}
          </Text>
        }
        renderItem={({ item: entry }) => {
          const item = entry.notification;
          return (
          <View
            style={[
              styles.item,
              {
                backgroundColor: t.surface,
                borderColor: t.border,
                borderLeftColor: SEVERITY_COLORS[item.severity] ?? t.accent,
                opacity: item.resolvedAt ? 0.55 : 1,
              },
            ]}
            accessible
            accessibilityLabel={`${item.severity} alert on ${item.channel}: ${item.title}`}
          >
            <View style={styles.itemTop}>
              <Text style={[styles.sev, { color: SEVERITY_COLORS[item.severity] ?? t.accent }]}>
                {item.severity.toUpperCase()}
              </Text>
              <Text style={[styles.channel, { color: t.muted, backgroundColor: t.surface2 }]}>
                {entry.sourceLabel} · {item.channel}
              </Text>
              <Text style={[styles.time, { color: t.muted }]}>
                {new Date(item.ts).toLocaleTimeString()}
              </Text>
            </View>
            <Text style={[styles.title, { color: t.text }]}>{item.title}</Text>
            {item.body ? <Text style={[styles.body, { color: t.muted }]}>{item.body}</Text> : null}
            {entry.resolvedAt ? (
              <Text style={[styles.resolved, { color: SEVERITY_COLORS.success }]}>Resolved</Text>
            ) : null}
          </View>
          );
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingTop: 56,
    paddingBottom: 12,
    borderBottomWidth: 1,
  },
  headerText: { flexShrink: 1 },
  headerRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  hub: { fontSize: 17, fontWeight: '700' },
  role: { fontSize: 12, marginTop: 2 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  status: { fontSize: 12 },
  unpair: { fontSize: 12, textDecorationLine: 'underline', marginLeft: 6 },
  list: { padding: 14, gap: 10 },
  emptyWrap: { flexGrow: 1, justifyContent: 'center', padding: 32 },
  empty: { textAlign: 'center', fontSize: 15, lineHeight: 22 },
  item: { borderWidth: 1, borderLeftWidth: 3, borderRadius: 12, padding: 14 },
  itemTop: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 4 },
  sev: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6 },
  channel: { fontSize: 11, paddingHorizontal: 6, paddingVertical: 1, borderRadius: 4, overflow: 'hidden' },
  time: { fontSize: 11, marginLeft: 'auto' },
  title: { fontSize: 15, fontWeight: '600' },
  body: { fontSize: 14, marginTop: 3, lineHeight: 20 },
  resolved: { fontSize: 12, fontWeight: '600', marginTop: 6 },
  serviceDown: { borderLeftWidth: 4, borderWidth: 1, margin: 14, marginBottom: 0, borderRadius: 12, padding: 14 },
  serviceDownTitle: { fontSize: 15, fontWeight: '700' },
  serviceDownBody: { fontSize: 13, marginTop: 4, lineHeight: 19 },
});
