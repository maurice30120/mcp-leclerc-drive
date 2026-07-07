/**
 * Contexte global de services (session WebView, runtime IA, historique).
 *
 * Couche minimale : injectée via React Context pour que les écrans restent
 * découplés. Le runtime IA distant Mistral est initialisé au lancement ; le
 * connecteur Leclerc reste créé par écran à partir de la session WebView.
 */

import React, { createContext, useContext, useMemo, useState, useCallback, useEffect } from 'react';
import { parseStoredWebSession, type WebSession } from '@features/webview/session';
import type { AIRuntime, RuntimeState } from '@features/ai/runtime';
import { McpLogger } from '@features/mcp/logs';
import { SessionHistory } from '@features/mcp/history';
import { InMemoryPermissionGate } from '@features/mcp/permissions';

export interface AppServices {
  session: { state: WebSession | null };
  runtime: { state: RuntimeState; initialize: () => Promise<void>; ai: AIRuntime | null };
  setSession: (s: WebSession | null) => void;
  logger: McpLogger;
  history: SessionHistory;
  gate: InMemoryPermissionGate;
  initializeAI: () => Promise<void>;
}

const Ctx = createContext<AppServices | null>(null);
const SESSION_STATE_FILE = 'leclerc-web-session.json';

export function AppServicesProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<WebSession | null>(null);
  const [runtimeState, setRuntimeState] = useState<RuntimeState>({ status: 'idle' });
  const [aiRuntime, setAiRuntime] = useState<AIRuntime | null>(null);

  const logger = useMemo(() => new McpLogger(), []);
  const history = useMemo(() => new SessionHistory(), []);
  const gate = useMemo(() => new InMemoryPermissionGate(), []);

  useEffect(() => {
    let cancelled = false;
    async function loadStoredSession() {
      try {
        const RNFS = await import('react-native-fs');
        const path = `${RNFS.DocumentDirectoryPath}/${SESSION_STATE_FILE}`;
        const exists = await RNFS.exists(path);
        if (!exists) return;
        const stored = parseStoredWebSession(await RNFS.readFile(path, 'utf8'));
        if (!cancelled && stored) setSession(stored);
      } catch {
        /* Session cache is best effort; WebView can publish a fresh session. */
      }
    }
    loadStoredSession();
    return () => {
      cancelled = true;
    };
  }, []);

  const setSessionPersisted = useCallback((next: WebSession | null) => {
    setSession(next);
    void (async () => {
      try {
        const RNFS = await import('react-native-fs');
        const path = `${RNFS.DocumentDirectoryPath}/${SESSION_STATE_FILE}`;
        if (!next) {
          if (await RNFS.exists(path)) await RNFS.unlink(path);
          return;
        }
        // V1: on persiste uniquement host/storeId/UA, jamais les cookies ni les identifiants.
        await RNFS.writeFile(path, JSON.stringify(next), 'utf8');
      } catch {
        /* L'état mémoire reste utilisable même si la persistance échoue. */
      }
    })();
  }, []);

  const initializeAI = useCallback(async () => {
    const { createMistralRuntime } = await import('../features/ai/mistral-runtime.ts');
    try {
      const rt = await createMistralRuntime(setRuntimeState);
      setAiRuntime(rt);
    } catch (e) {
      setRuntimeState({ status: 'error', error: (e as Error).message });
      setAiRuntime(null);
    }
  }, []);

  useEffect(() => {
    void initializeAI();
  }, [initializeAI]);

  const value: AppServices = useMemo(
    () => ({
      session: { state: session },
      runtime: { state: runtimeState, initialize: initializeAI, ai: aiRuntime },
      setSession: setSessionPersisted,
      logger,
      history,
      gate,
      initializeAI,
    }),
    [session, runtimeState, initializeAI, aiRuntime, setSessionPersisted, logger, history, gate],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAppServices(): AppServices {
  const v = useContext(Ctx);
  if (!v) throw new Error('AppServicesProvider manquant');
  return v;
}
