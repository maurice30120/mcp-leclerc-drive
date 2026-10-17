/**
 * Écran Assistant : chat simple avec appels outils Drive et debug brut Mistral.
 */

import React, { useRef, useState } from 'react';
import { View, Text, TextInput, Button, StyleSheet, FlatList, Alert, ScrollView } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAppServices } from '@app/AppServices';
import { createMobileConnector } from '@features/leclerc/mobile-connector';
import type { RootStackParamList } from '@app/App';
import {
  DriveChatViewModel,
  type ChatLine,
  type PendingToolConfirmation,
  type SendResult,
} from './DriveChatViewModel';

type Props = NativeStackScreenProps<RootStackParamList, 'Assistant'>;

export function AssistantScreen({}: Props) {
  const services = useAppServices();
  const [text, setText] = useState('');
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [pending, setPending] = useState<PendingToolConfirmation[]>([]);
  const [rawModel, setRawModel] = useState<string | null>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [busy, setBusy] = useState(false);
  const vmRef = useRef<DriveChatViewModel | null>(null);
  const sessionKeyRef = useRef<string | null>(null);
  const aiRef = useRef(services.runtime.ai);

  const applyResult = (result: SendResult) => {
    setLines(result.lines);
    setPending(result.pending);
    setRawModel(result.rawModel);
  };

  const vm = () => {
    const session = services.session.state;
    if (!session) throw new Error('Connecte-toi via la WebView Leclerc d abord.');
    const sessionKey = `${session.host}|${session.storeId}|${session.userAgent}`;
    if (!vmRef.current || sessionKeyRef.current !== sessionKey || aiRef.current !== services.runtime.ai) {
      vmRef.current = new DriveChatViewModel({
        connector: createMobileConnector(session),
        gate: services.gate,
        logger: services.logger,
        history: services.history,
        ai: services.runtime.ai,
      });
      sessionKeyRef.current = sessionKey;
      aiRef.current = services.runtime.ai;
      setLines([]);
      setPending([]);
      setRawModel(null);
    }
    return vmRef.current;
  };

  const onSend = async () => {
    setBusy(true);
    try {
      const result = await vm().sendUserMessage(text);
      applyResult(result);
      setText('');
    } catch (e) {
      Alert.alert('Erreur', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async (id: string) => {
    setBusy(true);
    try {
      applyResult(await vm().confirmTool(id));
    } catch (e) {
      Alert.alert('Erreur', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const onReject = (id: string) => {
    try {
      applyResult(vm().rejectTool(id));
    } catch (e) {
      Alert.alert('Erreur', (e as Error).message);
    }
  };

  const onClear = () => {
    if (!vmRef.current) {
      setLines([]);
      setPending([]);
      setRawModel(null);
      return;
    }
    applyResult(vmRef.current.clear());
    setText('');
  };

  return (
    <View style={styles.container}>
      <FlatList
        data={lines}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.messages}
        ListEmptyComponent={
          <Text style={styles.empty}>
            Demande un produit, le panier ou le magasin. Le modèle peut appeler les outils Drive.
          </Text>
        }
        renderItem={({ item }) => (
          <View style={[styles.bubble, item.role === 'user' ? styles.userBubble : styles.assistantBubble]}>
            <Text style={styles.role}>{roleLabel(item.role)}</Text>
            <Text style={styles.message}>{item.text}</Text>
          </View>
        )}
      />

      {pending.length > 0 && (
        <View style={styles.pendingBox}>
          <Text style={styles.pendingTitle}>Confirmation requise</Text>
          {pending.map((item) => (
            <View key={item.id} style={styles.pendingItem}>
              <Text style={styles.pendingText}>{item.command} : {item.label}</Text>
              <View style={styles.pendingActions}>
                <Button title="Confirmer" onPress={() => onConfirm(item.id)} disabled={busy} />
                <Button title="Refuser" onPress={() => onReject(item.id)} color="#b00020" disabled={busy} />
              </View>
            </View>
          ))}
        </View>
      )}

      {rawModel && (
        <View style={styles.debugBox}>
          <Button
            title={showRaw ? 'Masquer retour brut modèle' : 'Afficher retour brut modèle'}
            onPress={() => setShowRaw(!showRaw)}
          />
          {showRaw && (
            <ScrollView style={styles.rawScroll}>
              <Text selectable style={styles.rawText}>{rawModel}</Text>
            </ScrollView>
          )}
        </View>
      )}

      <View style={styles.inputBox}>
        <TextInput
          style={styles.input}
          placeholder="Message à l assistant courses"
          value={text}
          onChangeText={setText}
          multiline
        />
        <View style={styles.actions}>
          <Button title="Envoyer" onPress={onSend} disabled={busy || !text.trim()} />
          <Button title="Nouveau chat" onPress={onClear} disabled={busy} />
        </View>
      </View>
    </View>
  );
}

function roleLabel(role: ChatLine['role']): string {
  if (role === 'user') return 'Moi';
  if (role === 'tool') return 'Outil Drive';
  return 'Assistant';
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 12, gap: 10, backgroundColor: '#fff' },
  messages: { gap: 8, paddingBottom: 8 },
  empty: { color: '#666', fontSize: 14, padding: 12, textAlign: 'center' },
  bubble: { borderRadius: 8, padding: 10, gap: 4, maxWidth: '92%' },
  userBubble: { alignSelf: 'flex-end', backgroundColor: '#e8f0fe' },
  assistantBubble: { alignSelf: 'flex-start', backgroundColor: '#f5f5f5' },
  role: { fontSize: 11, color: '#666', fontWeight: '700' },
  message: { fontSize: 14, color: '#222' },
  pendingBox: { borderWidth: 1, borderColor: '#f0c36d', borderRadius: 8, padding: 10, gap: 8 },
  pendingTitle: { fontWeight: '700' },
  pendingItem: { gap: 6 },
  pendingText: { fontSize: 13, color: '#222' },
  pendingActions: { flexDirection: 'row', gap: 8 },
  debugBox: { borderWidth: 1, borderColor: '#ddd', borderRadius: 8, padding: 8, gap: 8 },
  rawScroll: { maxHeight: 180, backgroundColor: '#111', borderRadius: 6, padding: 8 },
  rawText: { color: '#f5f5f5', fontSize: 11, fontFamily: 'Menlo' },
  inputBox: { gap: 8 },
  input: { borderWidth: 1, borderColor: '#ccc', borderRadius: 8, padding: 12, minHeight: 72 },
  actions: { flexDirection: 'row', gap: 8, justifyContent: 'space-between' },
});
