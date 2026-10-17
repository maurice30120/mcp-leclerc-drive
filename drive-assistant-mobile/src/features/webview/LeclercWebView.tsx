/**
 * Écran WebView Leclerc officielle.
 *
 * - Login Leclerc Drive (page officielle, jamais de capture de mot de passe).
 * - Panier réel visible.
 * - Rafraîchissement de session : au chargement, on sonde l'URL courante pour
 *   dériver host/storeId/UA ; dès qu'on est sur une page magasin, la session
 *   est publiée au contexte global (AppServices). Le connecteur réutilise le
 *   cookie jar de la WebView pour ses fetch.
 *
 * Sécurité : le modèle n'a JAMAIS accès à cette WebView. Aucun checkout/paiement
 * n'est lancé depuis ici.
 */

import React, { useRef } from 'react';
import { View, StyleSheet, Button, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import type { NativeStackScreenProps } from '@react-navigation/native-stack';
import { deriveWebSession, LOGIN_CONFIRM_JS, SESSION_PROBE_JS, parseWebViewMessage } from './session';
import { useAppServices } from '@app/AppServices';
import type { RootStackParamList } from '@app/App';

const LECLERC_HOME = 'https://www.leclercdrive.fr/';
const NativeWebView = WebView as React.ComponentType<any>;

type Props = NativeStackScreenProps<RootStackParamList, 'WebView'>;

export function LeclercWebViewScreen({}: Props) {
  const ref = useRef<any>(null);
  const services = useAppServices();
  const publishSession = (url: string, userAgent: string) => {
    const s = deriveWebSession(url, userAgent);
    if (s) services.setSession(s);
  };

  return (
    <View style={styles.container}>
      <View style={styles.toolbar}>
        <Button title="Rafraîchir session" onPress={() => ref.current?.injectJavaScript(SESSION_PROBE_JS)} />
        <Button title="État login" onPress={() => ref.current?.injectJavaScript(LOGIN_CONFIRM_JS)} />
      </View>
      <NativeWebView
        ref={ref}
        source={{ uri: LECLERC_HOME }}
        sharedCookiesEnabled
        javaScriptEnabled
        domStorageEnabled
        onNavigationStateChange={(nav: { url?: string }) => {
          if (nav.url) publishSession(nav.url, '');
        }}
        onMessage={(e: { nativeEvent: { data: string } }) => {
          const msg = parseWebViewMessage(e.nativeEvent.data);
          if (!msg) return;
          if (msg.type === 'session_probe' || msg.type === 'login_state') {
            publishSession(msg.url, msg.userAgent);
          }
        }}
        onLoadEnd={() => ref.current?.injectJavaScript(`${SESSION_PROBE_JS}\n${LOGIN_CONFIRM_JS}`)}
      />
      <Text style={styles.note}>
        Aucun mot de passe n'est stocké. La session reste dans le cookie jar de la WebView.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  toolbar: { flexDirection: 'row', justifyContent: 'space-around', padding: 8, backgroundColor: '#f5f5f5' },
  note: { fontSize: 11, color: '#888', padding: 8, textAlign: 'center' },
});
