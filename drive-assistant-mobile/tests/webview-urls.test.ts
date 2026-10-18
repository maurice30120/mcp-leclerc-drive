import { test, assert } from './helpers.ts';
import { DEFAULT_STORE_ID, forceMobileFacadeJs, mobileStoreUrl, mobileUrlForNavigation } from '../src/features/webview/urls.ts';

test('mobileStoreUrl : démarre sur une page magasin mobile, pas sur la racine blanche', () => {
  assert.equal(
    mobileStoreUrl(),
    `https://m-courses.leclercdrive.fr/magasin-${DEFAULT_STORE_ID}-${DEFAULT_STORE_ID}/`,
  );
  assert.equal(
    mobileStoreUrl('053701'),
    'https://m-courses.leclercdrive.fr/magasin-053701-053701/',
  );
});

test('forceMobileFacadeJs : ne force aucune redirection', () => {
  const js = forceMobileFacadeJs(mobileStoreUrl('018201'));

  assert.ok(!js.includes('location.replace'));
  assert.ok(!js.includes('window.location.href'));
});

test('mobileUrlForNavigation : laisse une page magasin fd se stabiliser après redirection serveur', () => {
  assert.equal(
    mobileUrlForNavigation(
      'https://fd11-courses.leclercdrive.fr/magasin-018201-018201-montauban---sapiac/recherche.aspx?TexteRecherche=lait',
      mobileStoreUrl('018201'),
    ),
    null,
  );
});

test('mobileUrlForNavigation : garde une page magasin mobile', () => {
  assert.equal(
    mobileUrlForNavigation('https://m-courses.leclercdrive.fr/magasin-018201-018201/panier.aspx', mobileStoreUrl('018201')),
    null,
  );
});

test('mobileUrlForNavigation : ne force pas de fallback depuis une page Leclerc générique', () => {
  assert.equal(
    mobileUrlForNavigation('https://www.leclercdrive.fr/?mag=018201-018201&sRedirect=false', mobileStoreUrl('018201')),
    null,
  );
});
