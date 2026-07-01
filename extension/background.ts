/**
 * Extension background service worker.
 *
 * Watches for Leclerc Drive navigations and injects the WebMCP tool bridge
 * (inject.js) into the page's MAIN world so it can install
 * `document.modelContext` tools against the live Leclerc session.
 *
 * MV3 service workers can be terminated by Chrome; the listener is registered
 * at module top-level so it is re-armed on every wake.
 */

const LECRERC_URL_FILTER = {
  url: [{ hostSuffix: "leclercdrive.fr" }],
};

// inject.js installs @mcp-b/global (document.modelContext runtime) and our 8
// tools; embed.js then opens the WebSocket to the local relay and forwards
// those tools as first-class MCP tools. Both are injected into the page's
// MAIN world — inject.js first so embed.js sees a ready document.modelContext.
// MAIN-world scripts have no access to chrome.* APIs, so anything chrome-*
// (including the relay embed) must be driven through this list ordering.
const INJECT_FILES = ["inject.js", "embed.js"];

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  if (!tab.url || !isLeclercUrl(tab.url)) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: INJECT_FILES,
    });
    await chrome.action.setBadgeText({ tabId, text: "ON" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#1f8a3f" });
  } catch (err) {
    // The page must still be present; most failures here are "frame removed"
    // during a navigation race. Log to the extension DevTools console.
    console.error(`[mcp-leclerc-drive] inject failed for tab ${tabId}:`, err);
    try {
      await chrome.action.setBadgeText({ tabId, text: "ERR" });
      await chrome.action.setBadgeBackgroundColor({ tabId, color: "#b00020" });
    } catch {
      /* badge not settable on transient tabs */
    }
  }
});

// Re-inject on extension reload / browser start for any Leclerc tab already open.
chrome.runtime.onStartup.addListener(async () => {
  await reinjectAllLeclercTabs();
});
chrome.runtime.onInstalled.addListener(async () => {
  await reinjectAllLeclercTabs();
});

async function reinjectAllLeclercTabs(): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({ url: "*://*.leclercdrive.fr/*" });
    for (const tab of tabs) {
      if (tab.id == null) continue;
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          files: INJECT_FILES,
        });
        await chrome.action.setBadgeText({ tabId: tab.id, text: "ON" });
        await chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: "#1f8a3f" });
      } catch (err) {
        console.error(`[mcp-leclerc-drive] re-inject failed for tab ${tab.id}:`, err);
      }
    }
  } catch (err) {
    console.error(`[mcp-leclerc-drive] tabs.query failed:`, err);
  }
}

function isLeclercUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && u.hostname.endsWith(".leclercdrive.fr");
  } catch {
    return false;
  }
}