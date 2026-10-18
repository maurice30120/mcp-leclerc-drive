/**
 * Hôte WebView Leclerc persistant — overlay au niveau racine.
 *
 * PROBLÈME : tant que la WebView vivait dans la stack de navigation
 * (`Stack.Screen name="WebView"`), elle était **démontée** au `goBack`/
 * `pop`. Le `ref` disparaissait, le `WebViewFetchBridge` était détaché
 * (`attach(null)`), et les appels Leclerc depuis l'Assistant échouaient avec
 * « WebView Leclerc non attachée » — même après login.
 *
 * SOLUTION : la WebView est montée **une fois pour toutes** au niveau racine,
 * en overlay plein écran. Affichée via `services.webViewVisible`, mais
 * toujours montée après première ouverture (cachée avec `opacity:0` +
 * `pointerEvents:'none'`). Le `ref` (et donc le pont fetch) persiste sur tous
 * les écrans : l'Assistant peut exécuter des fetch à l'intérieur de la
 * WebView même quand elle est cachée.
 *
 * La WebView n'est montée qu'après la première ouverture (`everOpened`) pour
 * ne pas charger Leclerc au lancement de l'app.
 *
 * Sécurité : le modèle n'a JAMAIS accès à cette WebView. Aucun checkout/paiement
 * n'est lancé depuis ici.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, StyleSheet, Button, Text } from 'react-native';
import { WebView } from 'react-native-webview';
import { deriveWebSession, LOGIN_CONFIRM_JS, SESSION_PROBE_JS, parseWebViewMessage } from './session';
import { DEFAULT_STORE_ID, mobileStoreUrl } from './urls';
import { useAppServices } from '@app/AppServices';

const NativeWebView = WebView as React.ComponentType<any>;

export function WebViewHost() {
  const services = useAppServices();
  const bridge = services.webViewFetchBridge;
  const webViewRef = useRef<any>(null);
  const targetMobileUrl = mobileStoreUrl(services.session.state?.storeId ?? DEFAULT_STORE_ID);
  const [webViewUri] = useState(targetMobileUrl);
  // La WebView n'est instanciée qu'après la première ouverture, puis reste
  // montée pour toujours (le ref et le pont fetch persistent).
  const [everOpened, setEverOpened] = useState(false);
  const visible = services.webViewVisible;
  useEffect(() => {
    if (visible) setEverOpened(true);
  }, [visible]);

  const publishSession = (url: string, userAgent: string) => {
    const s = deriveWebSession(url, userAgent);
    if (s) services.setSession(s);
  };

  // Callback ref : attache/détache le pont fetch à la WebView vivante.
  const setWebViewRef = useCallback(
    (ref: any) => {
      webViewRef.current = ref;
      bridge.attach(
        ref ? (js: string) => ref.injectJavaScript(js) : null,
        services.session.state?.host ?? null,
      );
    },
    [bridge, services.session.state],
  );

  // Recale l'hôte attendu + le storeId (pour l'auto-navigation) quand la session change.
  useEffect(() => {
    bridge.setExpectedHost(services.session.state?.host ?? null);
    bridge.setStoreId(services.session.state?.storeId ?? null);
  }, [bridge, services.session.state]);

  if (!everOpened) return null;

  return (
    <View
      style={[styles.overlay, visible ? styles.overlayVisible : styles.overlayHidden]}
      pointerEvents={visible ? 'auto' : 'none'}
    >
      <View style={styles.toolbar}>
        <Button
          title="Rafraîchir session"
          onPress={() => webViewRef.current?.injectJavaScript(SESSION_PROBE_JS)}
        />
        <Button
          title="État login"
          onPress={() => webViewRef.current?.injectJavaScript(LOGIN_CONFIRM_JS)}
        />
        <Button title="Recharger" onPress={() => webViewRef.current?.reload()} />
        <Button title="Fermer" onPress={() => services.setWebViewVisible(false)} />
      </View>
      <NativeWebView
        ref={setWebViewRef}
        style={styles.webView}
        source={{ uri: webViewUri }}
        sharedCookiesEnabled
        javaScriptEnabled
        domStorageEnabled
        onShouldStartLoadWithRequest={() => true}
        onNavigationStateChange={(nav: { url?: string }) => {
          if (nav.url) publishSession(nav.url, '');
        }}
        onMessage={(e: { nativeEvent: { data: string } }) => {
          const data = e.nativeEvent.data;
          // 1) D'abord le pont fetch (réponses de fetch injectés).
          if (bridge.handleMessage(data)) return;
          // 2) Sinon, sonde de session / état login.
          const msg = parseWebViewMessage(data);
          if (!msg) return;
          if (msg.type === 'session_probe' || msg.type === 'login_state') {
            publishSession(msg.url, msg.userAgent);
          }
        }}
        onLoadEnd={() => {
          bridge.notifyLoadEnded();
          webViewRef.current?.injectJavaScript(`${SESSION_PROBE_JS}\n${LOGIN_CONFIRM_JS}`);
        }}
      />
      <Text style={styles.note}>
        Aucun mot de passe n'est stocké. La session reste dans le cookie jar de la WebView.
        {'\n'}Garde cette page sur ton drive : les appels courses passent par elle, même depuis le Chat.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: '#fff',
    zIndex: 50,
  },
  overlayVisible: { opacity: 1 },
  overlayHidden: { opacity: 0 },
  webView: {
    ...StyleSheet.absoluteFillObject,
  },
  toolbar: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    zIndex: 2,
    flexDirection: 'row',
    justifyContent: 'space-around',
    flexWrap: 'wrap',
    padding: 8,
    backgroundColor: '#f5f5f5',
  },
  note: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 2,
    fontSize: 11,
    color: '#888',
    padding: 8,
    textAlign: 'center',
    backgroundColor: '#fff',
  },
});
