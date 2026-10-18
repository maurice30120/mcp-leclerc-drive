/**
 * Side panel protocol + session state machine (ticket #51).
 *
 * The protocol module (src/sidepanel-protocol/protocol.ts) is the pure, node-
 * testable seam between the side panel UI and the background service worker:
 * the typed message envelope, the flow phases and the session state machine
 * whose BLOCKING rule is that no cart mutation can be permitted before the
 * explicit approval event. These tests encode the acceptance criteria of the
 * state machine; the UI itself is verified manually (docs/testing/
 * sidepanel-opt-in.md).
 */
import { test, assert } from "./helpers.ts";
import {
  SidePanelSession,
  SESSION_SNAPSHOT_FORMAT_VERSION,
  SIDEPANEL_REQUEST_CHANNEL,
  SIDEPANEL_EVENT_CHANNEL,
  isSidePanelRequestEnvelope,
  isSidePanelEventEnvelope,
  buildSidePanelPrompt,
  buildSimulatedRecipeScript,
  type SidePanelProviderId,
  type SidePanelRequest,
} from "../src/sidepanel-protocol/protocol.ts";
import { parseRecipeText } from "@leclerc/contracts";
import { validateModelManifest } from "@leclerc/agent";
import { LOCAL_MODEL_MANIFEST } from "../src/sidepanel-protocol/local-model.ts";

const PREVIEW = {
  recipeTitle: "Poulet au curry",
  servings: 4,
  lines: [
    {
      productId: "P-1001",
      label: "Filets de poulet 600 g",
      ingredient: "filets de poulet",
      quantity: 2,
      unitPrice: 7.2,
      lineTotal: 14.4,
      packaging: "600 g",
      matchScore: 2,
    },
  ],
  total: 14.4,
};

const QUESTION = {
  kind: "ambiguous_match",
  ingredient: "lait de coco",
  candidates: [
    { productId: "P-1003", label: "Lait de coco 400 ml", price: 1.95, packaging: "400 ml" },
    { productId: "P-2001", label: "Lait de coco 200 ml", price: 1.35, packaging: "200 ml" },
  ],
  message: "Plusieurs produits correspondent à « lait de coco ». Lequel faut-il ajouter ?",
};

/** Drive a session up to the approval wait (the observable UI journey). */
function driveToAwaitingApproval(session: SidePanelSession): void {
  session.selectProvider("simulated");
  assert.ok(session.startFlow({ message: "un poulet au curry pour 4", servings: 4 }).ok);
  session.markSearching();
  session.presentPreview(PREVIEW);
  session.awaitApproval("Ajouter 1 article(s) au panier — total 14.40 €.");
}

// ---- provider selection: explicit, never defaulted -------------------------

test("sidepanel: aucun fournisseur par défaut, start_flow refusé sans sélection explicite", () => {
  const session = new SidePanelSession();
  assert.equal(session.getState().provider, "none");
  const refused = session.startFlow({ message: "un plat pour 4", servings: 4 });
  assert.ok(!refused.ok, "start_flow doit être refusé sans fournisseur sélectionné");
  assert.match(refused.error, /fournisseur/i);
  assert.equal(session.getState().phase, "idle");
});

test("sidepanel: sélection explicite du fournisseur puis start_flow accepté", () => {
  const session = new SidePanelSession();
  assert.ok(session.selectProvider("simulated").ok);
  assert.equal(session.getState().provider, "simulated");
  const started = session.startFlow({ message: "un poulet au curry pour 4", servings: 4 });
  assert.ok(started.ok);
  assert.equal(session.getState().phase, "generating");
  assert.equal(session.getState().flowActive, true);
  assert.ok(
    session.getState().history.some((e) => e.role === "user" && e.text.includes("poulet au curry")),
  );
});

test("sidepanel: pas de changement de fournisseur pendant un parcours actif", () => {
  const session = new SidePanelSession();
  session.selectProvider("simulated");
  session.startFlow({ message: "un plat pour 4", servings: 4 });
  const switched = session.selectProvider("mistral");
  assert.ok(!switched.ok, "le fournisseur ne peut pas changer en cours de parcours");
  assert.equal(session.getState().provider, "simulated");
});

test("sidepanel: start_flow refuse une demande vide ou des convives invalides", () => {
  const session = new SidePanelSession();
  session.selectProvider("mistral");
  assert.ok(!session.startFlow({ message: "   ", servings: 4 }).ok);
  assert.ok(!session.startFlow({ message: "un plat", servings: 0 }).ok);
  assert.ok(!session.startFlow({ message: "un plat", servings: 2.5 }).ok);
  assert.equal(session.getState().phase, "idle");
});

// ---- phases -----------------------------------------------------------------

test("sidepanel: phases du parcours jusqu'à l'approbation", () => {
  const session = new SidePanelSession();
  driveToAwaitingApproval(session);
  const state = session.getState();
  assert.equal(state.phase, "awaiting_approval");
  assert.ok(state.pendingApproval, "l'attente d'approbation doit être visible dans l'état");
  assert.equal(state.pendingApproval?.preview.recipeTitle, "Poulet au curry");
  assert.ok(state.history.some((e) => e.kind === "preview"));
  assert.ok(state.history.some((e) => e.kind === "approval"));
});

// ---- BLOCKING SAFETY RULE: no mutation before the approval event ------------

test("sidepanel: aucune mutation permise avant l'événement d'approbation (règle bloquante)", () => {
  const session = new SidePanelSession();
  driveToAwaitingApproval(session);
  // Still waiting, not yet approved: every mutation request must be blocked.
  const blocked = session.assertMutationPermitted();
  assert.ok(!blocked.ok, "la mutation doit être bloquée avant l'approbation");
  assert.equal(blocked.code, "APPROVAL_REQUIRED");
  assert.match(blocked.message, /approbation/i);
  // The explicit approval event opens the door — and only it.
  const approved = session.approve();
  assert.ok(approved.ok);
  assert.equal(approved.preview.recipeTitle, "Poulet au curry");
  assert.equal(session.getState().phase, "mutating");
  const permitted = session.assertMutationPermitted();
  assert.ok(permitted.ok, "la mutation doit être permise après l'approbation explicite");
});

test("sidepanel: le refus laisse le parcours arrêté et toute mutation bloquée", () => {
  const session = new SidePanelSession();
  driveToAwaitingApproval(session);
  const refused = session.refuse("trop cher");
  assert.ok(refused.ok);
  const state = session.getState();
  assert.equal(state.phase, "idle", "le refus arrête le parcours");
  assert.equal(state.flowActive, false);
  assert.equal(state.pendingApproval, undefined);
  const blocked = session.assertMutationPermitted();
  assert.ok(!blocked.ok, "aucune mutation après un refus");
  // A new flow can start (from the stopped state) and starts unapproved again.
  assert.ok(session.startFlow({ message: "une autre recette", servings: 2 }).ok);
  assert.ok(!session.assertMutationPermitted().ok);
});

test("sidepanel: l'approbation ne survit pas à la fin d'un parcours", () => {
  const session = new SidePanelSession();
  driveToAwaitingApproval(session);
  session.approve();
  assert.ok(session.assertMutationPermitted().ok);
  session.finishFlow("completed");
  assert.equal(session.getState().phase, "done");
  assert.ok(
    !session.assertMutationPermitted().ok,
    "une nouvelle approbation est requise pour tout parcours suivant",
  );
});

test("sidepanel: approve/refuse refusés hors de la phase d'attente", () => {
  const session = new SidePanelSession();
  session.selectProvider("simulated");
  assert.ok(!session.approve().ok, "approve sans attente d'approbation doit échouer");
  assert.ok(!session.refuse().ok, "refuse sans attente d'approbation doit échouer");
});

// ---- clarification round trip ------------------------------------------------

test("sidepanel: aller-retour de clarification (question posée puis réponse)", () => {
  const session = new SidePanelSession();
  session.selectProvider("simulated");
  session.startFlow({ message: "un plat pour 4", servings: 4 });
  session.markSearching();
  session.awaitClarification(QUESTION);
  const state = session.getState();
  assert.ok(state.pendingClarification, "la question doit être visible dans l'état");
  assert.equal(state.pendingClarification?.ingredient, "lait de coco");
  const answered = session.answerClarification({ productId: "P-2001" });
  assert.ok(answered.ok);
  assert.deepEqual(answered.answer, { productId: "P-2001" });
  assert.equal(session.getState().pendingClarification, undefined);
  // No pending question: an answer is an explicit error, never a guess.
  const orphan = session.answerClarification({ productId: "P-1003" });
  assert.ok(!orphan.ok);
});

test("sidepanel: la clarification peut être passée (skip) explicitement", () => {
  const session = newPanelSearchSession();
  session.awaitClarification(QUESTION);
  const skipped = session.answerClarification({ skip: true });
  assert.ok(skipped.ok);
  assert.deepEqual(skipped.answer, { skip: true });
  assert.equal(session.getState().pendingClarification, undefined);
});

function newPanelSearchSession(): SidePanelSession {
  const session = new SidePanelSession();
  session.selectProvider("simulated");
  session.startFlow({ message: "un plat pour 4", servings: 4 });
  session.markSearching();
  return session;
}

// ---- session-only history semantics -------------------------------------------

test("sidepanel: l'historique survit à un cycle serialize/restore (suspension MV3)", () => {
  const session = new SidePanelSession();
  driveToAwaitingApproval(session);
  const snapshot = session.serialize();
  assert.equal(snapshot.formatVersion, SESSION_SNAPSHOT_FORMAT_VERSION);
  // chrome.storage.session stores JSON: the snapshot must survive the round trip.
  const restored = SidePanelSession.restore(JSON.parse(JSON.stringify(snapshot)));
  const state = restored.getState();
  assert.equal(state.provider, "simulated");
  assert.equal(state.phase, "awaiting_approval");
  assert.equal(state.pendingApproval?.preview.recipeTitle, "Poulet au curry");
  assert.deepEqual(
    state.history.map((e) => [e.role, e.kind, e.text]),
    session.getState().history.map((e) => [e.role, e.kind, e.text]),
  );
  // The restored approval wait still blocks mutations and can be approved.
  assert.ok(!restored.assertMutationPermitted().ok);
  assert.ok(restored.approve().ok);
  assert.ok(restored.assertMutationPermitted().ok);
});

test("sidepanel: un instantané de format inconnu est rejeté", () => {
  const session = new SidePanelSession();
  const snapshot = session.serialize();
  assert.throws(() => SidePanelSession.restore({ ...snapshot, formatVersion: 999 }));
});

test("sidepanel: reset_session vide historique et parcours mais garde le fournisseur", () => {
  const session = new SidePanelSession();
  driveToAwaitingApproval(session);
  session.setMistralKeySet(true);
  session.setResume({
    preview: PREVIEW,
    pending: PREVIEW.lines,
    applied: [],
    failed: undefined,
  });
  session.reset();
  const state = session.getState();
  assert.equal(state.provider, "simulated", "la sélection de fournisseur est un réglage, pas une conversation");
  assert.deepEqual(state.history, []);
  assert.equal(state.phase, "idle");
  assert.equal(state.flowActive, false);
  assert.equal(state.pendingApproval, undefined);
  assert.equal(state.resumeAvailable, false);
  assert.equal(state.mistralKeySet, true);
});

test("sidepanel: l'instantané ne contient jamais la clé Mistral", () => {
  const session = new SidePanelSession();
  session.selectProvider("mistral");
  session.setMistralKeySet(true);
  const raw = JSON.stringify(session.serialize());
  assert.equal(session.getState().mistralKeySet, true);
  assert.ok(!raw.includes("apiKey"), "aucune clé ne doit traverser l'état de session");
  assert.ok(!raw.toLowerCase().includes("sk-"), "aucun secret ne doit fuiter dans l'instantané");
});

// ---- resume -------------------------------------------------------------------

test("sidepanel: reprise disponible après un échec partiel, consommée à la complétion", () => {
  const session = new SidePanelSession();
  session.selectProvider("simulated");
  session.startFlow({ message: "un plat pour 4", servings: 4 });
  session.setResume({
    preview: PREVIEW,
    pending: PREVIEW.lines,
    applied: [],
    failed: undefined,
  });
  assert.equal(session.getState().resumeAvailable, true);
  session.finishFlow("partial_failure");
  assert.equal(session.getState().phase, "error");
  assert.equal(session.getState().resumeAvailable, true, "l'échec partiel laisse la reprise disponible");
  session.finishFlow("completed");
  assert.equal(session.getState().resumeAvailable, false, "la complétion consomme la reprise");
});

test("sidepanel: la reprise exige une approbation FRAÎCHE avant toute mutation", () => {
  const session = new SidePanelSession();
  driveToAwaitingApproval(session);
  session.approve();
  assert.ok(session.assertMutationPermitted().ok);
  session.setResume({ preview: PREVIEW, pending: PREVIEW.lines, applied: [], failed: undefined });
  session.finishFlow("partial_failure");
  assert.ok(!session.assertMutationPermitted().ok, "l'approbation précédente ne porte pas sur la reprise");
  assert.ok(session.beginResume(PREVIEW).ok);
  assert.equal(session.getState().phase, "preview");
  session.awaitApproval("Reprendre : ajouter les 1 article(s) restant(s).");
  assert.equal(session.getState().phase, "awaiting_approval");
  assert.ok(!session.assertMutationPermitted().ok, "une nouvelle approbation est requise avant de reprendre");
  assert.ok(session.approve().ok);
  assert.ok(session.assertMutationPermitted().ok);
  session.finishFlow("completed");
  assert.equal(session.getState().resumeAvailable, false);
});

test("sidepanel: beginResume refusé sans reprise disponible", () => {
  const session = new SidePanelSession();
  assert.ok(!session.beginResume(PREVIEW).ok);
});

// ---- message envelope guards ---------------------------------------------------

test("sidepanel: isSidePanelRequestEnvelope accepte les requêtes valides et rejette le reste", () => {
  const ok = (request: SidePanelRequest) => ({ channel: SIDEPANEL_REQUEST_CHANNEL, request });
  assert.ok(isSidePanelRequestEnvelope(ok({ type: "get_state" })));
  assert.ok(
    isSidePanelRequestEnvelope(
      ok({ type: "start_flow", message: "un poulet au curry", servings: 4, exclusions: ["crème"] }),
    ),
  );
  assert.ok(isSidePanelRequestEnvelope(ok({ type: "set_provider", providerId: "webgpu" })));
  assert.ok(isSidePanelRequestEnvelope(ok({ type: "approve" })));
  assert.ok(isSidePanelRequestEnvelope(ok({ type: "clarify_answer", answer: { skip: true } })));
  assert.ok(!isSidePanelRequestEnvelope({ channel: "autre", request: { type: "get_state" } }));
  assert.ok(!isSidePanelRequestEnvelope({ channel: SIDEPANEL_REQUEST_CHANNEL }));
  assert.ok(
    !isSidePanelRequestEnvelope({
      channel: SIDEPANEL_REQUEST_CHANNEL,
      request: { type: "unknown_thing" },
    }),
  );
  assert.ok(
    !isSidePanelRequestEnvelope({
      channel: SIDEPANEL_REQUEST_CHANNEL,
      request: { type: "start_flow", message: "", servings: 4 },
    }),
  );
  assert.ok(!isSidePanelRequestEnvelope(null));
  assert.ok(!isSidePanelRequestEnvelope("sidepanel"));
});

test("sidepanel: isSidePanelEventEnvelope filtre les événements du canal sidepanel", () => {
  assert.ok(
    isSidePanelEventEnvelope({
      channel: SIDEPANEL_EVENT_CHANNEL,
      event: { type: "state", state: new SidePanelSession().getState() },
    }),
  );
  assert.ok(
    isSidePanelEventEnvelope({
      channel: SIDEPANEL_EVENT_CHANNEL,
      event: { type: "phase", phase: "searching" },
    }),
  );
  assert.ok(
    !isSidePanelEventEnvelope({ channel: SIDEPANEL_EVENT_CHANNEL, event: { type: "nope" } }),
  );
  assert.ok(!isSidePanelEventEnvelope({ event: { type: "phase", phase: "idle" } }));
  assert.ok(!isSidePanelEventEnvelope(undefined));
});

// ---- providers: prompt builder + simulated demo script -------------------------

test("sidepanel: buildSidePanelPrompt produit une invite déterministe avec l'historique", () => {
  const prompt = buildSidePanelPrompt([
    { role: "system", content: "Tu es un assistant de cuisine." },
    { role: "user", content: "Un poulet au curry pour 4." },
  ]);
  assert.ok(prompt.includes("SYSTEM:"));
  assert.ok(prompt.includes("Tu es un assistant de cuisine."));
  assert.ok(prompt.includes("USER:"));
  assert.ok(prompt.includes("Un poulet au curry pour 4."));
  assert.ok(prompt.trimEnd().endsWith("ASSISTANT:"));
  // Repair round: the previous assistant answer is replayed before the new ask.
  const repair = buildSidePanelPrompt([
    { role: "system", content: "Tu es un assistant de cuisine." },
    { role: "user", content: "Un poulet au curry pour 4." },
    { role: "assistant", content: '{"title": "raté"}' },
    { role: "user", content: "Corrige le JSON." },
  ]);
  assert.ok(repair.indexOf('{"title": "raté"}') < repair.indexOf("Corrige le JSON."));
  assert.ok(repair.indexOf("Un poulet au curry pour 4.") < repair.indexOf('{"title": "raté"}'));
});

test("sidepanel: buildSimulatedRecipeScript produit une recette valide conforme à la demande", () => {
  const script = buildSimulatedRecipeScript({
    message: "un poulet au curry pour 4",
    servings: 4,
  });
  assert.equal(script.length, 2, "la génération + l'unique réparation guidée sont scriptées");
  for (const step of script) {
    const parsed = parseRecipeText(step.text);
    assert.ok(parsed.ok, `la recette simulée doit être strictement valide : ${JSON.stringify(parsed)}`);
    if (parsed.ok) {
      assert.equal(parsed.recipe.servings, 4);
      assert.ok(parsed.recipe.ingredients.length >= 4);
      assert.ok(parsed.recipe.steps.length >= 3);
    }
  }
  const forSix = buildSimulatedRecipeScript({ message: "pareil pour 6", servings: 6 });
  const parsedSix = parseRecipeText(forSix[0].text);
  assert.ok(parsedSix.ok && parsedSix.recipe.servings === 6);
});

test("sidepanel: la recette simulée respecte les exclusions demandées", () => {
  const script = buildSimulatedRecipeScript({
    message: "un poulet au curry sans crème pour 4",
    servings: 4,
    exclusions: ["crème"],
  });
  const parsed = parseRecipeText(script[0].text);
  assert.ok(parsed.ok);
  if (parsed.ok) {
    for (const ingredient of parsed.recipe.ingredients) {
      assert.ok(
        !ingredient.name.toLowerCase().includes("crème"),
        `l'exclusion « crème » ne doit jamais apparaître (trouvé dans « ${ingredient.name} »)`,
      );
    }
  }
});

// ---- local model manifest (download consent pipeline trust anchor) --------------

test("sidepanel: le manifeste du modèle local est valide et vérifiable", () => {
  const validation = validateModelManifest(LOCAL_MODEL_MANIFEST);
  assert.ok(
    validation.ok,
    `le manifeste doit passer la validation stricte : ${JSON.stringify(validation)}`,
  );
  if (validation.ok) {
    const sum = validation.manifest.files.reduce((acc, f) => acc + f.sizeBytes, 0);
    assert.equal(validation.manifest.totalSizeBytes, sum);
    assert.ok(validation.manifest.files.every((f) => /^[0-9a-f]{64}$/.test(f.sha256 ?? "")));
    assert.ok(validation.manifest.sourceUrl.startsWith("https://huggingface.co/"));
    assert.equal(validation.manifest.format, "onnx");
  }
});

test("sidepanel: le type de fournisseur du protocole couvre exactement les trois fournisseurs câblés", () => {
  const providers: SidePanelProviderId[] = ["simulated", "webgpu", "mistral"];
  assert.deepEqual([...providers].sort(), ["mistral", "simulated", "webgpu"]);
});
