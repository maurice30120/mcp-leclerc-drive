/**
 * Réglages IA : saisie et stockage sécurisé de la clé API Mistral.
 *
 * Cet écran ne touche pas à la session Leclerc. Il ne gère que la clé Mistral
 * utilisée par le runtime IA. Le SecureStore applicatif est adossé au
 * Keychain/Keystore natif via react-native-keychain.
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Button, StyleSheet, Text, TextInput, View } from 'react-native';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';

import type { RootStackParamList } from './App';
import { useAppServices } from './AppServices';
import { MISTRAL_API_BASE_URL, MISTRAL_MODEL } from '@features/ai/env.generated';
import {
  deleteMistralApiKey,
  envMistralApiKey,
  getStoredMistralApiKey,
  saveMistralApiKey,
} from '@features/ai/api-key-storage';
import { MistralChatClient } from '@features/ai/mistral-client';

type Props = NativeStackScreenProps<RootStackParamList, 'Settings'>;

export function SettingsScreen({}: Props) {
  const services = useAppServices();
  const [apiKey, setApiKey] = useState('');
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const stored = await getStoredMistralApiKey();
      setHasStoredKey(!!stored);
      setApiKey(stored ?? envMistralApiKey() ?? '');
    } catch (e) {
      Alert.alert('SecureStore', (e as Error).message);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(async () => {
    setBusy(true);
    try {
      await saveMistralApiKey(apiKey);
      await reload();
      await services.initializeAI();
      Alert.alert('Mistral', 'Clé enregistrée dans le stockage sécurisé.');
    } catch (e) {
      Alert.alert('Mistral', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [apiKey, reload, services]);

  const test = useCallback(async () => {
    setBusy(true);
    try {
      const key = await saveMistralApiKey(apiKey);
      const client = new MistralChatClient({
        apiKey: key,
        model: MISTRAL_MODEL,
        serverURL: MISTRAL_API_BASE_URL,
        maxTokens: 16,
        temperature: 0,
      });
      await client.complete([
        { role: 'system', content: 'Réponds uniquement en JSON valide.' },
        { role: 'user', content: 'Retourne {"ok":true}.' },
      ]);
      await reload();
      await services.initializeAI();
      Alert.alert('Mistral', 'Clé testée avec succès.');
    } catch (e) {
      Alert.alert('Mistral', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [apiKey, reload, services]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      await deleteMistralApiKey();
      await reload();
      await services.initializeAI();
      Alert.alert('Mistral', 'Clé stockée supprimée. La clé .env reste disponible comme bootstrap POC.');
    } catch (e) {
      Alert.alert('Mistral', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [reload, services]);

  return (
    <View style={styles.container}>
      <Text style={styles.h}>Réglages Mistral</Text>

      <View style={styles.card}>
        <Text style={styles.label}>Clé API Mistral</Text>
        <TextInput
          value={apiKey}
          onChangeText={setApiKey}
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder="mistral api key"
          style={styles.input}
        />
        <Text style={styles.meta}>
          Statut : {hasStoredKey ? 'clé stockée dans le SecureStore applicatif' : 'clé .env non encore importée'}
        </Text>
        <Text style={styles.meta}>
          POC uniquement : la clé reste côté app mobile. À sortir derrière un backend avant diffusion.
        </Text>
      </View>

      <View style={styles.actions}>
        <Button title="Enregistrer" onPress={save} disabled={busy} />
        <Button title="Tester la clé" onPress={test} disabled={busy} />
        <Button title="Supprimer la clé stockée" onPress={remove} disabled={busy || !hasStoredKey} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, padding: 20, gap: 16, backgroundColor: '#fff' },
  h: { fontSize: 22, fontWeight: '700' },
  card: { borderWidth: 1, borderColor: '#ddd', borderRadius: 12, padding: 16, gap: 8 },
  label: { fontSize: 16, fontWeight: '600' },
  input: {
    minHeight: 44,
    borderWidth: 1,
    borderColor: '#ccc',
    borderRadius: 8,
    paddingHorizontal: 12,
    fontSize: 14,
  },
  meta: { fontSize: 12, color: '#666' },
  actions: { gap: 10 },
});
