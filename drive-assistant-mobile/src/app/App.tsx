/**
 * Drive Assistant Mobile — racine + navigation.
 *
 * Stack React Native CLI. Les dépendances natives WebView/RNFS et l'API IA
 * Mistral sont initialisées hors de cette racine. Aucune logique critique ici :
 * les invariants sont défendus par les modules *features/* (testés).
 */

import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { AppServicesProvider } from './AppServices';
import { HomeScreen } from './HomeScreen';
import { LeclercWebViewScreen } from '@features/webview/LeclercWebView';
import { AssistantScreen } from '@features/assistant/AssistantScreen';
import { HistoryScreen } from './HistoryScreen';
import { SettingsScreen } from './SettingsScreen';

export type RootStackParamList = {
  Home: undefined;
  WebView: undefined;
  Assistant: undefined;
  History: undefined;
  Settings: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();

export default function App() {
  return (
    <SafeAreaProvider>
     <AppServicesProvider>
      <NavigationContainer>
        <Stack.Navigator initialRouteName="Home">
          <Stack.Screen name="Home" component={HomeScreen} options={{ title: 'Drive Assistant' }} />
          <Stack.Screen name="WebView" component={LeclercWebViewScreen} options={{ title: 'Leclerc Drive' }} />
          <Stack.Screen name="Assistant" component={AssistantScreen} options={{ title: 'Chat courses' }} />
          <Stack.Screen name="History" component={HistoryScreen} options={{ title: 'Historique' }} />
          <Stack.Screen name="Settings" component={SettingsScreen} options={{ title: 'Réglages IA' }} />
        </Stack.Navigator>
      </NavigationContainer>
     </AppServicesProvider>
    </SafeAreaProvider>
  );
}
