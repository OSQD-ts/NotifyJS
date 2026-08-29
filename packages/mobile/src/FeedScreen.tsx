import { FlatList, RefreshControl, StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import type { ConnectionStatus, Notification } from '@notifyjs/protocol';
import { SEVERITY_COLORS, useTheme } from './theme';

interface Props {
  notifications: Notification[];
  status: ConnectionStatus;
  role: string | undefined;
  hubName: string;
  snoozedUntil: number;
  serviceDown: { title: string; body?: string } | undefined;
  onRefresh(): void;
  onUnpair(): void;
  onSnooze(): void;
}

const STATUS_COLORS: Partial<Record<ConnectionStatus, string>> = {
  ready: '#35c48a',
  connecting: '#e0a33a',
  reconnecting: '#e0a33a',
  error: '#ff6b6b',
  revoked: '#ff6b6b',
};

export function FeedScreen({
  notifications,
  status,
  role,
  hubName,
  snoozedUntil,
  serviceDown,
  onRefresh,
  onUnpair,
  onSnooze,
}: Props) {
  const t = useTheme();
  const snoozing = snoozedUntil > Date.now();

  return (
    <View style={[styles.root, { backgroundColor: t.bg }]}>
      <View style={[styles.header, { borderColor: t.border, backgroundColor: t.surface }]}>
        <View style={styles.headerText}>
          <Text style={[styles.hub, { color: t.text }]}>{hubName}</Text>
          <Text style={[styles.role, { color: t.muted }]}>{role ? `role: ${role}` : 'not paired'}</Text>
        </View>
        <View style={styles.headerRight}>
          <View style={[styles.dot, { backgroundColor: STATUS_COLORS[status] ?? t.muted }]} />
          <Text style={[styles.status, { color: t.muted }]}>{status}</Text>
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
          <TouchableOpacity onPress={onUnpair} hitSlop={10} accessibilityRole="button">
            <Text style={[styles.unpair, { color: t.muted }]}>Unpair</Text>
          </TouchableOpacity>
        </View>
      </View>

      {serviceDown ? (
        <View
          style={[styles.serviceDown, { backgroundColor: t.surface, borderColor: SEVERITY_COLORS.critical }]}
          accessibilityRole="alert"
        >
          <Text style={[styles.serviceDownTitle, { color: SEVERITY_COLORS.critical }]}>
            {serviceDown.title}
          </Text>
          {serviceDown.body ? (
            <Text style={[styles.serviceDownBody, { color: t.muted }]}>{serviceDown.body}</Text>
          ) : null}
        </View>
      ) : null}

      <FlatList
        data={notifications}
        keyExtractor={(n) => n.id}
        contentContainerStyle={notifications.length === 0 ? styles.emptyWrap : styles.list}
        refreshControl={
          <RefreshControl refreshing={false} onRefresh={onRefresh} tintColor={t.muted} />
        }
        ListEmptyComponent={
          <Text style={[styles.empty, { color: t.muted }]}>
            Nothing yet. Alerts from your app will appear here.
          </Text>
        }
        renderItem={({ item }) => (
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
                {item.channel}
              </Text>
              <Text style={[styles.time, { color: t.muted }]}>
                {new Date(item.ts).toLocaleTimeString()}
              </Text>
            </View>
            <Text style={[styles.title, { color: t.text }]}>{item.title}</Text>
            {item.body ? <Text style={[styles.body, { color: t.muted }]}>{item.body}</Text> : null}
            {item.resolvedAt ? (
              <Text style={[styles.resolved, { color: SEVERITY_COLORS.success }]}>Resolved</Text>
            ) : null}
          </View>
        )}
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
