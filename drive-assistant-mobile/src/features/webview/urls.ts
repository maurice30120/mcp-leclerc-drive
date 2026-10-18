const LECLERC_MOBILE_HOST = 'm-courses.leclercdrive.fr';

export const DEFAULT_STORE_ID = '018201';

export function mobileStoreUrl(storeId: string = DEFAULT_STORE_ID): string {
  return `https://${LECLERC_MOBILE_HOST}/magasin-${storeId}-${storeId}/`;
}

export function mobileUrlForNavigation(url: string, fallbackUrl: string): string | null {
  void url;
  void fallbackUrl;
  return null;
}

export function forceMobileFacadeJs(targetUrl: string): string {
  void targetUrl;
  return `
(function() {
  // Navigation is intentionally left to the Leclerc site/WebView.
})();
true;
`;
}
