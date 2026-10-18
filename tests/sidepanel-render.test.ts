import { test, assert } from "./helpers.ts";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Execute the actual panel controller against a minimal DOM. No extension,
// API key, live account or browser session is needed for these interaction tests.
class Element {
  children: Element[] = [];
  listeners: Record<string, () => void> = {};
  dataset = {};
  disabled = false;
  hidden = false;
  selected = false;
  scrolledIntoView = false;
  className = "";
  private text = "";
  private currentValue: string | undefined;
  readonly tagName: string;
  constructor(tagName = "div") { this.tagName = tagName; }
  set textContent(value: string) { this.text = value; this.children = []; }
  get textContent(): string { return this.text + this.children.map((child) => child.textContent).join(" "); }
  set value(value: string) { this.currentValue = value; }
  get value(): string { return this.currentValue ?? this.children.find((child) => child.selected)?.value ?? (this.tagName === "select" ? this.children[0]?.value : "") ?? ""; }
  set innerHTML(_value: string) { throw new Error("Catalogue data must never use innerHTML"); }
  appendChild(child: Element) { this.children.push(child); return child; }
  setAttribute() {}
  addEventListener(name: string, listener: () => void) { this.listeners[name] = listener; }
  querySelectorAll(tag: string): Element[] { return this.children.flatMap((child) => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  scrollIntoView() { this.scrolledIntoView = true; }
  click() { if (!this.disabled) this.listeners.click?.(); }
}

function panel(next: any) {
  const elements = new Map<string, Element>();
  const requests: any[] = [];
  const get = (id: string) => { if (!elements.has(id)) elements.set(id, new Element()); return elements.get(id)!; };
  const context: any = {
    document: { getElementById: get, createElement: (tag: string) => new Element(tag), querySelectorAll: () => [] },
    chrome: { runtime: { sendMessage: async (message: any) => { requests.push(message.request); return { ok: true }; }, onMessage: { addListener() {} }, connect: () => ({ onDisconnect: { addListener() {} }, postMessage() {} }) } },
    setInterval() {}, window: { confirm: () => false },
  };
  runInNewContext(readFileSync(new URL("../extension/sidepanel/sidepanel.js", import.meta.url), "utf8"), context);
  context.applyState({ history: [], provider: "mistral", mistralKeySet: true, model: {}, flowActive: false, resumeAvailable: false, phase: "reviewing", ...next });
  const button = (label: string) => get("thread").querySelectorAll("button").find((node) => node.textContent === label)!;
  return { get, button, requests };
}

const progress = {
  flowId: "flow-test",
  finished: false,
  entries: [{ ingredientIndex: 0, ingredient: "Riz", status: "added", added: 2, removed: 0, line: { label: "Riz 1 kg" } }],
  cart: { items: [{ product: { label: "Riz 1 kg" }, quantity: 7, lineTotal: 14 }], total: 14 },
};

function cartProgressBody(ui: ReturnType<typeof panel>) {
  return ui.get("thread").querySelectorAll("div").find((node) => node.className.indexOf("cart-progress-body") !== -1)!;
}

function cartProgressToggle(ui: ReturnType<typeof panel>) {
  return ui.get("thread").querySelectorAll("button").find((node) => node.textContent.indexOf("Panier ") === 0)!;
}

test("panel: cart progress is collapsed by default and expands on toggle click", () => {
  const ui = panel({ cartProgress: progress });
  assert.equal(cartProgressBody(ui).hidden, true, "the preparation log must be reduced by default");
  const toggle = cartProgressToggle(ui);
  assert.ok(toggle.textContent.indexOf("1 ajouté(s)") !== -1, "the collapsed header carries a count summary");
  assert.ok(toggle.textContent.indexOf("étendre") !== -1);
  assert.notEqual(ui.button("Terminer la vérification"), undefined, "the finish action stays visible while collapsed");
  toggle.click();
  assert.equal(cartProgressBody(ui).hidden, false);
  assert.ok(cartProgressToggle(ui).textContent.indexOf("réduire") !== -1);
  assert.ok(ui.get("thread").textContent.includes("Riz 1 kg × 7"));
  cartProgressToggle(ui).click();
  assert.equal(cartProgressBody(ui).hidden, true);
});

test("panel: final review shows the filled cart and removes only the run's contribution", async () => {
  const ui = panel({ cartProgress: progress });
  cartProgressToggle(ui).click();
  assert.ok(ui.get("thread").textContent.includes("Riz 1 kg × 7"));
  assert.ok(ui.get("thread").textContent.includes("2 paquet(s) ajouté(s) par ce parcours"));
  assert.equal(ui.button("Terminer la vérification").disabled, false);
  assert.equal(ui.button("Approuver et ajouter au panier"), undefined);
  ui.button("Supprimer l'ajout de l'agent").click();
  await Promise.resolve();
  assert.equal(ui.requests.at(-1).type, "remove_prepared");
  assert.equal(ui.requests.at(-1).ingredientIndex, 0);
});

test("panel: three uncertain candidates require a human choice before an add request", async () => {
  const ui = panel({ phase: "searching", flowActive: true, resumeAvailable: true, cartProgress: progress, pendingReview: {
    items: [{ ingredientIndex: 1, ingredient: "Haricots", uncertain: true, reason: "Trois produits plausibles", candidates: [0, 1, 2].map((index) => ({ productId: String(index), label: index === 0 ? "<script>catalogue</script>" : `Haricots ${index}`, price: 2, quantity: 1 })) }],
  } });
  assert.equal(ui.get("phase-chip").textContent, "Choix nécessaires");
  assert.equal(ui.get("resume-bar").hidden, true);
  assert.equal(ui.requests.length, 1, "initial get_state only, no automatic choice");
  const reviewCard = ui.get("thread").querySelectorAll("div").find((node) => node.className.indexOf("product-review") !== -1)!;
  assert.ok(reviewCard.scrolledIntoView, "the review card must be brought into view, not hidden above the cart progress");
  assert.ok(ui.get("thread").textContent.includes("<script>catalogue</script>"));
  const select = ui.get("thread").querySelectorAll("select")[0];
  assert.equal(select.value, "");
  ui.button("Ajouter les produits choisis").click();
  assert.equal(ui.requests.length, 1);
  select.value = "1";
  select.listeners.change();
  ui.button("Ajouter les produits choisis").click();
  await Promise.resolve();
  assert.equal(ui.requests.at(-1).type, "review_answer");
  assert.equal(ui.requests.at(-1).choices[0].productId, "1");
  assert.equal(ui.button("Terminer la vérification").disabled, true);
});

test("panel: unknown packaging requires an explicit positive package count", async () => {
  const ui = panel({ phase: "searching", flowActive: true, cartProgress: progress, pendingReview: { items: [{ ingredientIndex: 0, ingredient: "Haricots", uncertain: true, reason: "Poids inconnu", candidates: [{ productId: "beans", label: "Haricots", price: 2, quantity: 1, quantityNote: "Conditionnement inconnu" }] }] } });
  const select = ui.get("thread").querySelectorAll("select")[0];
  select.value = "0"; select.listeners.change();
  const input = ui.get("thread").querySelectorAll("input")[0];
  assert.equal(input.hidden, false);
  ui.button("Ajouter les produits choisis").click();
  assert.equal(ui.requests.length, 1);
  input.value = "2";
  ui.button("Ajouter les produits choisis").click();
  await Promise.resolve();
  assert.equal(ui.requests.at(-1).choices[0].quantity, 2);
});

test("panel: cancelling the run requests removal of every agent addition", async () => {
  const ui = panel({ cartProgress: progress });
  ui.button("Annuler les ajouts du parcours").click();
  await Promise.resolve();
  assert.equal(ui.requests.at(-1).type, "cancel_prepared");
  assert.equal(ui.requests.at(-1).flowId, "flow-test");
});

test("panel: unverified cart mutations cannot be silently finished or removed", () => {
  const ui = panel({ cartProgress: { ...progress, intent: { productId: "rice", target: 7 } } });
  cartProgressToggle(ui).click();
  assert.equal(ui.button("Terminer la vérification").disabled, true);
  assert.equal(ui.button("Supprimer l'ajout de l'agent").disabled, true);
});
