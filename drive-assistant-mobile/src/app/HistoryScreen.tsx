/**
 * Écran Historique : actions MCP (logs) + produits ajoutés en session (avec
 * annulation possible via remove_from_cart).
 */

import React, { useState, useMemo } from 'react';
import { View, Text, FlatList, Button, StyleSheet } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAppServices } from './AppServices';
import { createMobileConnector } from '@features/leclerc/mobile-connector';
import { McpRunner } from '@features/mcp/runner';
import type { RootStackParamList } from './App';

type Props = NativeStackScreenProps<RootStackParamList, 'History'>;

export function HistoryScreen({}: Props) {
  const services = useAppServices();
  const [, force] = useState(0);
  const logs = services.logger.all();
  const adds = services.history.activeAdds();

  const revert = async (productId: string, histId: string) => {
    const session = services.session.state;
    if (!session) return;
    const connector = createMobileConnector(session);
    const runner = new McpRunner({
      connector,
      gate: services.gate,
      logger: services.logger,
      history: services.history,
    });
    const ticket = services.gate.issue('remove_from_cart', { product_id: productId });
    await runner.runTool('remove_from_cart', { product_id: productId, label: '' }, { nonce: ticket.nonce });
    services.history.markReverted(histId);
    force((n) => n + 1);
  };

  return (
    <View style={styles.container}>
      <Text style={styles.h}>Actions MCP</Text>
      <FlatList
        data={logs}
        keyExtractor={(e) => e.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text style={styles.cmd}>
              {item.permission === 'mutation' ? '⚙️' : '👀'} {item.command} — {item.status}
            </Text>
            {item.text ? <Text style={styles.txt}>{item.text}</Text> : null}
            {item.error ? <Text style={styles.err}>{item.error}</Text> : null}
          </View>
        )}
      />

      <Text style={[styles.h, { marginTop: 16 }]}>Produits ajoutés (session)</Text>
      <FlatList
        data={adds}
        keyExtractor={(e) => e.id}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Text>
              {item.quantity}× {item.label ?? item.productId}
            </Text>
            <Button title="Annuler l’ajout" onPress={() => revert(item.productId, item.id)} />
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 16, gap: 8, backgroundColor: '#fff' },
  h: { fontSize: 18, fontWeight: '700' },
  row: { padding: 12, borderWidth: 1, borderColor: '#eee', borderRadius: 8, gap: 4 },
  cmd: { fontWeight: '600' },
  txt: { fontSize: 12, color: '#555' },
  err: { fontSize: 12, color: '#c0392b' },
});