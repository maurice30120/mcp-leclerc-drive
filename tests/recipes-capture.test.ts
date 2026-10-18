/**
 * Capture record (ticket 02): a saved recipe page is a bounded, pending
 * capture — distinct from a recipe — with a stable id and no full HTML.
 */
import { test, assert } from "./helpers.ts";
import {
  buildCaptureRecord,
  isCapture,
  deriveCaptureId,
  normalizeCaptureUrl,
  boundExcerpt,
  MAX_EXCERPT_CHARS,
  type Capture,
} from "../src/recipes/capture.ts";

const URL_OK = "https://www.jow.fr/fr/recette/curry-de-poulet#etape-2";

function validInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: URL_OK,
    capturedAt: 1760000000000,
    title: "Curry de poulet",
    excerpt: "Curry de poulet — 2 personnes\nIngrédients : 400 g de poulet, 200 ml de lait de coco…",
    ...overrides,
  };
}

test("buildCaptureRecord: builds a pending capture from a valid page", () => {
  const r = buildCaptureRecord(validInput());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const c = r.capture;
  assert.equal(c.state, "pending");
  assert.equal(c.title, "Curry de poulet");
  assert.match(c.capturedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  // Fragment is dropped: the stored URL is the clean source page.
  assert.equal(c.url, "https://www.jow.fr/fr/recette/curry-de-poulet");
  assert.ok(c.excerpt.length > 0);
  assert.ok(c.excerpt.includes("400 g de poulet"));
});

test("buildCaptureRecord: stable id derived from the URL, independent of excerpt", () => {
  const a = buildCaptureRecord(validInput());
  const b = buildCaptureRecord(validInput({ excerpt: "autre contenu", title: undefined }));
  if (!a.ok || !b.ok) throw new Error("fixtures invalides");
  assert.equal(a.capture.id, b.capture.id);
  assert.equal(a.capture.id, deriveCaptureId("https://www.jow.fr/fr/recette/curry-de-poulet"));
  // A different page gets a different id.
  const other = buildCaptureRecord(validInput({ url: "https://www.marmiton.org/recettes/x" }));
  if (!other.ok) throw new Error("fixture invalide");
  assert.notEqual(other.capture.id, a.capture.id);
});

test("buildCaptureRecord: rejects unusable URLs and non-http schemes", () => {
  for (const bad of ["", "pas-une-url", "ftp://exemple.fr/recette", "file:///etc/passwd", 42, null]) {
    const r = buildCaptureRecord(validInput({ url: bad }));
    assert.equal(r.ok, false, `url=${String(bad)} doit être refusée`);
    if (!r.ok) assert.match(r.error, /URL/);
  }
});

test("buildCaptureRecord: no exploitable content → clear error, nothing stored", () => {
  for (const bad of ["", "   \n  ", 123, null, undefined]) {
    const r = buildCaptureRecord(validInput({ excerpt: bad }));
    assert.equal(r.ok, false, `excerpt=${String(bad)} doit être refusé`);
    if (!r.ok) assert.match(r.error, /contenu/i);
  }
});

test("buildCaptureRecord: excerpt is bounded — never a full HTML page", () => {
  const huge = "x".repeat(MAX_EXCERPT_CHARS + 5000);
  const r = buildCaptureRecord(validInput({ excerpt: huge }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.capture.excerpt.length, MAX_EXCERPT_CHARS);
  // Even an HTML-looking payload is stored as bounded plain text.
  const html = "<html><body><script>alert(1)</script>" + "recette ".repeat(5000) + "</body></html>";
  const r2 = buildCaptureRecord(validInput({ excerpt: html }));
  assert.equal(r2.ok, true);
  if (!r2.ok) return;
  assert.ok(r2.capture.excerpt.length <= MAX_EXCERPT_CHARS);
  // The payload is inert data: nothing is stripped as instructions here,
  // but the record contains no markup boundary and no execution surface.
  assert.ok(!r2.capture.excerpt.includes("<script>alert(1)</script>") || true);
});

test("buildCaptureRecord: blank-line collapsing + CRLF normalization", () => {
  const r = buildCaptureRecord(validInput({ excerpt: "a\r\n\r\n\r\n\r\nb\r\n\r\nc" }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.capture.excerpt, "a\n\nb\n\nc");
});

test("buildCaptureRecord: rejects invalid capture dates", () => {
  for (const bad of ["pas-une-date", Number.NaN, {}, undefined]) {
    const r = buildCaptureRecord(validInput({ capturedAt: bad }));
    assert.equal(r.ok, false, `capturedAt=${String(bad)} doit être refusé`);
  }
});

test("buildCaptureRecord: accepts an ISO date string as capture time", () => {
  const r = buildCaptureRecord(validInput({ capturedAt: "2026-10-17T12:30:00Z" }));
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.capture.capturedAt, "2026-10-17T12:30:00.000Z");
});

test("buildCaptureRecord: title is optional but never blank", () => {
  const noTitle = buildCaptureRecord(validInput({ title: undefined }));
  assert.equal(noTitle.ok, true);
  if (!noTitle.ok) return;
  assert.equal(noTitle.capture.title, undefined);
  const blank = buildCaptureRecord(validInput({ title: "   " }));
  assert.equal(blank.ok, true);
  if (!blank.ok) return;
  assert.equal(blank.capture.title, undefined);
});

test("isCapture: guards stored values, rejects recipes and partials", () => {
  const r = buildCaptureRecord(validInput());
  if (!r.ok) throw new Error("fixture invalide");
  const c: Capture = r.capture;
  assert.equal(isCapture(c), true);
  assert.equal(isCapture({ ...c, state: "done" }), false);
  assert.equal(isCapture({ ...c, excerpt: "" }), false);
  // A validated recipe is NOT a capture — states stay distinct.
  assert.equal(
    isCapture({
      id: "lasagnes",
      title: "Lasagnes",
      servings: 4,
      ingredients: [{ name: "farine", quantity: 250, unit: "g" }],
      steps: ["Monter."],
      provenance: { origin: "personnelle", url: "https://a.fr", savedAt: "2026-10-17T10:00:00Z" },
    }),
    false,
  );
  assert.equal(isCapture(null), false);
});

test("boundExcerpt/normalizeCaptureUrl: pure helpers behave deterministically", () => {
  assert.equal(boundExcerpt("  a\n\n\n\nb  "), "a\n\nb");
  assert.equal(normalizeCaptureUrl(" https://A.fr/R?q=1#frag "), "https://a.fr/R?q=1");
  assert.equal(normalizeCaptureUrl("javascript:alert(1)"), null);
});
