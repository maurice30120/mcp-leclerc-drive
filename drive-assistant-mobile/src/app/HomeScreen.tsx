/**
 * Écran Accueil : état connexion Leclerc, état API IA, accès assistant et
 * accès WebView. Lit l'état partagé via le AppServices injecté via
 `useAppServices` (contexte minimal).
 */

import React from 'react';
import { View, Text, StyleSheet, Button } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { useAppServices } from './AppServices';
import type { RootStackParamList } from './App';

type Props = NativeStackScreenProps<RootStackParamList, 'Home'>;

export function HomeScreen({ navigation }: Props) {
  const services = useAppServices();
  const session = services.session.state;
  const ai = services.runtime.state;

  const connected = !!session?.connected;
  const aiReady = ai.status === 'ready';

  return (
    <View style={styles.container}>
      <Text style={styles.h}>Drive Assistant</Text>

      <View style={styles.card}>
        <Text style={styles.label}>
          Connexion Leclerc : {connected ? '✅ connectée' : '⚠️ non connectée'}
        </Text>
        {session && <Text style={styles.meta}>{session.storeId} @ {session.host}</Text>}
        <Button
          title="Ouvrir la WebView Leclerc"
          onPress={() => navigation.navigate('WebView')}
        />
      </View>

      <View style={styles.card}>
        <Text style={styles.label}>
          API Mistral : {!aiReady ? '⏳ ' + ai.status : '✅ prête'}
        </Text>
        <Text style={styles.meta}>{ai.modelId ?? '—'}</Text>
        <Text style={styles.meta}>
          POC : clé initialisée depuis .env puis stockée dans le SecureStore applicatif.
        </Text>
        {ai.error && <Text style={styles.error}>{ai.error}</Text>}
        <Button
          title="Réinitialiser l'API IA"
          onPress={() => services.initializeAI()}
          disabled={ai.status === 'loading'}
        />
        <Button
          title="Réglages Mistral"
          onPress={() => navigation.navigate('Settings')}
        />
      </View>

      <View style={styles.actions}>
        <Button
          title="Chat courses"
          onPress={() => navigation.navigate('Assistant')}
          disabled={!connected}
        />
        <View style={{ height: 8 }} />
        <Button title="Historique" onPress={() => navigation.navigate('History')} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 16, backgroundColor: '#fff' },
  h: { fontSize: 22, fontWeight: '700' },
  card: { borderWidth: 1, borderColor: '#ddd', borderRadius: 12, padding: 16, gap: 8 },
  label: { fontSize: 16, fontWeight: '600' },
  meta: { fontSize: 12, color: '#666' },
  error: { fontSize: 12, color: '#b00020' },
  actions: { marginTop: 8, gap: 8 },
});
