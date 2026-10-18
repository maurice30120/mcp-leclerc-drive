/**
 * Side panel UI controller (ticket #51) — the conversation surface of the
 * shopping agent (tickets #44/#50).
 *
 * Plain JavaScript on purpose: the panel is a static extension page copied
 * verbatim by the build; the protocol itself is typed and unit-tested in
 * src/sidepanel-protocol/protocol.ts. The channel + message type literals
 * below MUST stay in sync with that module.
 *
 * Safety invariants mirrored here:
 *   - uncertain ingredients require a grouped human choice;
 *   - final review removes only the run's confirmed contributions;
 *   - finishing review never adds a product;
 *   - catalogue labels (Leclerc data, untrusted) are rendered with
 *     textContent only, never as HTML;
 *   - the Mistral key is sent once and never displayed back;
 *   - the conversation is rendered from the state's history (session-only),
 *     so a service-worker suspension is survived visually.
 */

"use strict";

// Keep in sync with src/sidepanel-protocol/protocol.ts.
var REQUEST_CHANNEL = "mcp-leclerc-drive:sidepanel";
var EVENT_CHANNEL = "mcp-leclerc-drive:sidepanel-event";
var KEEPALIVE_PORT = "mcp-leclerc-drive:sidepanel-keepalive";

var PHASE_LABELS = {
  idle: "Prêt",
  generating: "Génération de la recette…",
  searching: "Recherche produits…",
  preview: "Aperçu du panier",
  awaiting_approval: "En attente de ton approbation",
  mutating: "Ajout au panier…",
  reviewing: "Révision du panier",
  done: "Terminé",
  error: "Erreur",
};

/** Last SidePanelState received from the background (single render source). */
var state = null;
var keepalivePort = null;

function $(id) {
  var el = document.getElementById(id);
  if (!el) throw new Error("#" + id + " manquant");
  return el;
}

// ---- background requests ----------------------------------------------------

function sendRequest(request) {
  return chrome.runtime
    .sendMessage({ channel: REQUEST_CHANNEL, request: request })
    .then(function (result) {
      if (result && result.ok && result.state) applyState(result.state);
      if (result && !result.ok) appendLocalError(result.error || "Demande refusée.");
      return result;
    })
    .catch(function (err) {
      appendLocalError("Service worker injoignable : " + describeError(err));
      return null;
    });
}

function describeError(err) {
  return err && err.message ? err.message : String(err);
}

function appendLocalError(message) {
  var thread = $("thread");
  var div = document.createElement("div");
  div.className = "msg error";
  div.textContent = message;
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
}

// ---- events -----------------------------------------------------------------

chrome.runtime.onMessage.addListener(function (msg) {
  if (!msg || msg.channel !== EVENT_CHANNEL || !msg.event) return;
  var event = msg.event;
  if (event.type === "state") {
    applyState(event.state);
  } else if (event.type === "error") {
    // Errors are also in the history via the state; nothing to do here.
  }
  // recipe / preview / approval_request / clarification / tool_activity /
  // flow_result / phase are all reflected by the state history.
});

// ---- state-driven rendering ---------------------------------------------------

function applyState(next) {
  state = next;
  if (state.flowActive) {
    var recipes = (state.history || []).filter(function (entry) { return entry.kind === "recipe"; });
    var latest = recipes[recipes.length - 1];
    if (latest && latest.data) $("servings").value = String(latest.data.servings);
  }
  $("send-btn").disabled = !!state.flowActive || !!(state.cartProgress && !state.cartProgress.finished);
  renderPhase();
  renderThread();
  renderSettings();
}

function renderPhase() {
  var chip = $("phase-chip");
  var phase = state ? state.phase : "idle";
  chip.dataset.phase = phase;
  chip.textContent = state && state.pendingReview ? "Choix nécessaires" : PHASE_LABELS[phase] || phase;
}

function textNode(parent, tag, text, className) {
  var el = document.createElement(tag);
  el.textContent = text;
  if (className) el.className = className;
  parent.appendChild(el);
  return el;
}

function renderThread() {
  var thread = $("thread");
  thread.textContent = "";
  if (!state) return;
  var history = state.history || [];
  for (var i = 0; i < history.length; i++) {
    renderEntry(thread, history[i], i === history.length - 1);
  }
  if (state.pendingReview) renderProductReview(thread, state.pendingReview, true);
  if (state.cartProgress) renderCartProgress(thread, state.cartProgress);
  var resumeBar = $("resume-bar");
  resumeBar.hidden = !state.resumeAvailable || state.flowActive;
  if (state.pendingReview) {
    // The review card is the actionable step; keep it in view instead of the
    // bottom of the (longer) cart progress card.
    var reviewCard = thread.querySelectorAll("div").filter(function (el) { return el.className.indexOf("product-review") !== -1; })[0];
    if (reviewCard) reviewCard.scrollIntoView();
  } else {
    thread.scrollTop = thread.scrollHeight;
  }
}

function renderEntry(thread, entry, isLast) {
  switch (entry.kind) {
    case "recipe":
      renderRecipeCard(thread, entry.data || {});
      break;
    case "preview":
      renderPreviewCard(thread, entry.data || {});
      break;
    case "approval":
      renderApprovalCard(thread, entry, isLast);
      break;
    case "review":
      break;
    case "clarification":
      renderClarificationCard(thread, entry, isLast);
      break;
    case "tool_activity":
      renderActivity(thread, entry);
      break;
    case "error":
      textNode(thread, "div", entry.text, "msg error");
      break;
    default:
      textNode(thread, "div", entry.text, "msg " + entry.role);
      break;
  }
}

function renderRecipeCard(thread, recipe) {
  var card = document.createElement("div");
  card.className = "card";
  textNode(card, "h3", recipe.title || "Recette");
  textNode(card, "div", "Pour " + (recipe.servings || "?") + " personnes", "meta");
  var ul = document.createElement("ul");
  (recipe.ingredients || []).forEach(function (ing) {
    textNode(ul, "li", ing.name + " — " + ing.quantity + " " + ing.unit);
  });
  card.appendChild(ul);
  var ol = document.createElement("ol");
  (recipe.steps || []).forEach(function (step) {
    textNode(ol, "li", step);
  });
  card.appendChild(ol);
  if (recipe.prepMinutes !== undefined || recipe.cookMinutes !== undefined) {
    var durations = [];
    if (recipe.prepMinutes !== undefined) durations.push("Préparation : " + recipe.prepMinutes + " min");
    if (recipe.cookMinutes !== undefined) durations.push("Cuisson : " + recipe.cookMinutes + " min");
    textNode(card, "div", durations.join(" · ") + " (indicatifs, non vérifiés)", "meta");
  }
  thread.appendChild(card);
}

function renderPreviewCard(thread, preview) {
  var card = document.createElement("div");
  card.className = "card";
  textNode(card, "h3", "Aperçu du panier — " + (preview.recipeTitle || "recette"));
  textNode(card, "div", "Pour " + (preview.servings || "?") + " personnes", "meta");
  var table = document.createElement("table");
  var head = document.createElement("tr");
  ["Article", "Qté", "Prix unitaire", "Total"].forEach(function (label) {
    textNode(head, "th", label);
  });
  table.appendChild(head);
  (preview.lines || []).forEach(function (line) {
    var tr = document.createElement("tr");
    textNode(tr, "td", line.label + (line.packaging ? " (" + line.packaging + ")" : ""));
    textNode(tr, "td", "× " + line.quantity);
    textNode(tr, "td", line.unitPrice.toFixed(2) + " €");
    textNode(tr, "td", line.lineTotal.toFixed(2) + " €");
    if (line.note) tr.title = line.note;
    table.appendChild(tr);
  });
  var total = document.createElement("tr");
  total.className = "total-row";
  textNode(total, "td", "Total");
  textNode(total, "td", "");
  textNode(total, "td", "");
  textNode(total, "td", (preview.total || 0).toFixed(2) + " €");
  table.appendChild(total);
  card.appendChild(table);
  textNode(
    card,
    "div",
    "Données du catalogue Leclerc : prix, conditionnements et disponibilités non garantis.",
    "disclaimer"
  );
  thread.appendChild(card);
}

function renderApprovalCard(thread, entry, isLast) {
  var card = document.createElement("div");
  card.className = "card";
  textNode(card, "h3", "Validation globale requise");
  textNode(card, "div", entry.text, "meta");
  var pending = isLast && state && state.pendingApproval;
  var actions = document.createElement("div");
  actions.className = "actions";
  var approveBtn = document.createElement("button");
  approveBtn.className = "primary";
  approveBtn.textContent = "Approuver et ajouter au panier";
  approveBtn.disabled = !pending;
  approveBtn.addEventListener("click", function () {
    approveBtn.disabled = true;
    refuseBtn.disabled = true;
    sendRequest({ type: "approve" });
  });
  var refuseBtn = document.createElement("button");
  refuseBtn.className = "danger";
  refuseBtn.textContent = "Refuser";
  refuseBtn.disabled = !pending;
  refuseBtn.addEventListener("click", function () {
    approveBtn.disabled = true;
    refuseBtn.disabled = true;
    sendRequest({ type: "refuse" });
  });
  actions.appendChild(approveBtn);
  actions.appendChild(refuseBtn);
  card.appendChild(actions);
  if (!pending) {
    textNode(card, "div", "Cette validation a déjà été traitée.", "meta");
  }
  thread.appendChild(card);
}

var cartProgressExpanded = false;
var cartProgressFlowId;

function renderCartProgress(thread, progress) {
  // New cart, fresh card: collapse again for each new run.
  if (cartProgressFlowId !== progress.flowId) {
    cartProgressFlowId = progress.flowId;
    cartProgressExpanded = false;
  }
  var card = document.createElement("div");
  card.className = "card cart-progress";
  var labels = { searching: "Recherche", verifying: "Vérification", added: "Ajouté", choice_needed: "Choix nécessaire", failed: "Échec", verification_pending: "Résultat à vérifier", skipped: "Non ajouté", removed: "Ajout supprimé" };
  var entries = progress.entries || [];
  var summary = [];
  var addedCount = entries.filter(function (entry) { return entry.added > entry.removed; }).length;
  var choiceCount = entries.filter(function (entry) { return entry.status === "choice_needed"; }).length;
  var failedCount = entries.filter(function (entry) { return entry.status === "failed"; }).length;
  if (addedCount) summary.push(addedCount + " ajouté(s)");
  if (choiceCount) summary.push(choiceCount + " à choisir");
  if (failedCount) summary.push(failedCount + " échec(s)");
  var toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "cart-progress-toggle";
  toggle.textContent = (progress.finished ? "Panier vérifié" : "Panier en cours de préparation")
    + (summary.length ? " — " + summary.join(", ") : "")
    + (cartProgressExpanded ? " — réduire" : " — étendre");
  toggle.addEventListener("click", function () {
    cartProgressExpanded = !cartProgressExpanded;
    renderThread();
  });
  card.appendChild(toggle);
  var body = document.createElement("div");
  body.className = "cart-progress-body";
  body.hidden = !cartProgressExpanded;
  entries.forEach(function (entry) {
    var row = document.createElement("div");
    row.className = "review-item";
    textNode(row, "div", entry.ingredient + " — " + (labels[entry.status] || entry.status));
    if (entry.line) textNode(row, "div", entry.line.label + " — " + (entry.added - entry.removed) + " paquet(s) ajouté(s) par ce parcours", "meta");
    if (entry.error) textNode(row, "div", entry.error, "msg error");
    if (entry.added > entry.removed && !progress.finished) {
      var remove = document.createElement("button");
      remove.className = "danger";
      remove.textContent = "Supprimer l'ajout de l'agent";
      remove.disabled = !!state.flowActive || !!progress.intent;
      remove.addEventListener("click", function () {
        remove.disabled = true;
        sendRequest({ type: "remove_prepared", flowId: progress.flowId, ingredientIndex: entry.ingredientIndex }).then(function (result) { if (!result || !result.ok) remove.disabled = false; });
      });
      row.appendChild(remove);
    }
    body.appendChild(row);
  });
  if (progress.cart) {
    textNode(body, "h4", "Dernier panier confirmé");
    textNode(body, "div", "Inclut les produits présents avant ce parcours. Une suppression retire uniquement les quantités ajoutées par l'agent.", "meta");
    var list = document.createElement("ul");
    (progress.cart.items || []).forEach(function (item) { textNode(list, "li", item.product.label + " × " + item.quantity + " — " + item.lineTotal.toFixed(2) + " €"); });
    body.appendChild(list);
    textNode(body, "div", "Total du panier : " + progress.cart.total.toFixed(2) + " €", "meta");
  }
  card.appendChild(body);
  if (!progress.finished) {
    var actions = document.createElement("div");
    actions.className = "actions";
    if (addedCount > 0) {
      var cancel = document.createElement("button");
      cancel.className = "danger";
      cancel.textContent = "Annuler les ajouts du parcours";
      cancel.disabled = !!state.flowActive || !!progress.intent;
      cancel.addEventListener("click", function () {
        cancel.disabled = true;
        sendRequest({ type: "cancel_prepared", flowId: progress.flowId }).then(function (result) { if (!result || !result.ok) cancel.disabled = false; });
      });
      actions.appendChild(cancel);
    }
    var finish = document.createElement("button");
    finish.className = "primary";
    finish.textContent = "Terminer la vérification";
    finish.disabled = !!state.flowActive || !!progress.intent;
    finish.addEventListener("click", function () {
      finish.disabled = true;
      sendRequest({ type: "finish_review", flowId: progress.flowId }).then(function (result) { if (!result || !result.ok) finish.disabled = false; });
    });
    actions.appendChild(finish);
    card.appendChild(actions);
  }
  thread.appendChild(card);
}

function renderProductReview(thread, review, pending) {
  var card = document.createElement("div");
  card.className = "card product-review";
  textNode(card, "h3", "Choix nécessaires");
  textNode(card, "div", "Les produits déjà vérifiés sont dans le panier. Choisis parmi ces propositions pour ajouter les ingrédients encore incertains.", "meta");
  var fields = [];
  (review.items || []).forEach(function (item) {
    var row = document.createElement("div");
    row.className = "review-item";
    textNode(row, "h4", item.ingredient + (item.uncertain ? " — à vérifier" : " — sélectionné"));
    textNode(row, "div", item.reason, "meta");
    var select = document.createElement("select");
    select.setAttribute("aria-label", "Produit pour " + item.ingredient);
    select.disabled = !pending;
    var empty = document.createElement("option");
    empty.value = "";
    empty.textContent = "Choisir un produit ou passer cet ingrédient";
    select.appendChild(empty);
    (item.candidates || []).forEach(function (candidate, index) {
      var option = document.createElement("option");
      option.value = String(index);
      option.textContent = candidate.label + " — " + candidate.price.toFixed(2) + " € / paquet"
        + (candidate.packaging ? " — " + candidate.packaging : "")
        + (candidate.quantityNote ? " — quantité à préciser" : " — × " + candidate.quantity + " = " + (candidate.quantity * candidate.price).toFixed(2) + " €")
        + (candidate.habitual ? " — habituel" : "")
        + (candidate.productId === item.recommendedProductId ? " — recommandé" : "");
      option.selected = candidate.productId === item.selectedProductId;
      select.appendChild(option);
    });
    var skip = document.createElement("option");
    skip.value = "skip";
    skip.textContent = "Ne pas ajouter cet ingrédient";
    select.appendChild(skip);
    var note = textNode(row, "div", "", "meta");
    var quantity = document.createElement("input");
    quantity.type = "number";
    quantity.min = "1";
    quantity.max = "999";
    quantity.step = "1";
    quantity.placeholder = "Nombre de paquets à acheter";
    quantity.setAttribute("aria-label", "Nombre de paquets pour " + item.ingredient);
    quantity.disabled = !pending;
    function refreshCandidate() {
      var candidate = item.candidates[Number(select.value)];
      if (select.value === "" || select.value === "skip") candidate = undefined;
      note.textContent = candidate ? [candidate.quantityNote, candidate.preparationChange ? "Ce choix peut modifier la préparation : vérifie la recette." : ""].filter(Boolean).join(" ") : "";
      quantity.hidden = !candidate || !candidate.quantityNote;
    }
    select.addEventListener("change", function () { quantity.value = ""; refreshCandidate(); });
    refreshCandidate();
    row.appendChild(select);
    row.appendChild(quantity);
    card.appendChild(row);
    fields.push({ item: item, select: select, quantity: quantity });
  });
  var error = textNode(card, "div", "", "msg error");
  var submit = document.createElement("button");
  submit.className = "primary";
  submit.textContent = "Ajouter les produits choisis";
  submit.disabled = !pending;
  submit.addEventListener("click", function () {
    var choices = [];
    for (var i = 0; i < fields.length; i++) {
      var field = fields[i];
      if (!field.select.value) { error.textContent = "Choisis un produit ou passe chaque ingrédient incertain."; return; }
      if (field.select.value === "skip") { choices.push({ ingredientIndex: field.item.ingredientIndex, skip: true }); continue; }
      var candidate = field.item.candidates[Number(field.select.value)];
      var choice = { ingredientIndex: field.item.ingredientIndex, productId: candidate.productId };
      if (candidate.quantityNote) {
        var count = Number(field.quantity.value);
        if (!Number.isSafeInteger(count) || count < 1 || count > 999) { error.textContent = "Indique le nombre de paquets à acheter (1 à 999)."; return; }
        choice.quantity = count;
      }
      choices.push(choice);
    }
    submit.disabled = true;
    sendRequest({ type: "review_answer", flowId: state.cartProgress.flowId, choices: choices }).then(function (result) {
      if (!result || !result.ok) submit.disabled = false;
    });
  });
  card.appendChild(submit);
  thread.appendChild(card);
}

function renderClarificationCard(thread, entry, isLast) {
  var card = document.createElement("div");
  card.className = "card";
  textNode(card, "h3", "Question");
  textNode(card, "div", entry.text, "meta");
  var pending = isLast && state && state.pendingClarification;
  var candidates = document.createElement("div");
  candidates.className = "candidates";
  (entry.data ? entry.data.candidates || [] : []).forEach(function (candidate) {
    var btn = document.createElement("button");
    btn.textContent =
      candidate.label +
      " — " +
      (candidate.price !== undefined ? candidate.price.toFixed(2) + " €" : "prix inconnu") +
      (candidate.packaging ? " (" + candidate.packaging + ")" : "");
    btn.disabled = !pending;
    btn.addEventListener("click", function () {
      disableCandidateButtons(candidates);
      sendRequest({ type: "clarify_answer", answer: { productId: candidate.productId } });
    });
    candidates.appendChild(btn);
  });
  var skip = document.createElement("button");
  skip.className = "danger";
  skip.textContent = "Ne pas ajouter cet ingrédient";
  skip.disabled = !pending;
  skip.addEventListener("click", function () {
    disableCandidateButtons(candidates);
    sendRequest({ type: "clarify_answer", answer: { skip: true } });
  });
  candidates.appendChild(skip);
  card.appendChild(candidates);
  thread.appendChild(card);
}

function disableCandidateButtons(container) {
  Array.prototype.forEach.call(container.querySelectorAll("button"), function (btn) {
    btn.disabled = true;
  });
}

function renderActivity(thread, entry) {
  var div = document.createElement("div");
  div.className = "activity";
  div.textContent = entry.text;
  if (entry.data && entry.data.products && entry.data.products.length) {
    var ul = document.createElement("ul");
    entry.data.products.forEach(function (product) {
      var li = textNode(ul, "li", product.label + " — " + (product.available ? product.price.toFixed(2) + " €" : "indisponible"));
      if (!product.available) li.className = "err";
    });
    div.appendChild(ul);
  }
  thread.appendChild(div);
}

// ---- settings --------------------------------------------------------------

function renderSettings() {
  if (!state) return;
  var provider = state.provider || "none";
  Array.prototype.forEach.call(
    document.querySelectorAll('input[name="provider"]'),
    function (radio) {
      radio.checked = radio.value === provider;
    }
  );
  var mistralStatus = $("mistral-status");
  mistralStatus.textContent = state.mistralKeySet ? "Clé enregistrée (jamais affichée)." : "Aucune clé enregistrée.";
  mistralStatus.className = state.mistralKeySet ? "ok" : "";
  var modelStatus = $("model-status");
  var model = state.model || {};
  var lines = [];
  if (model.cacheState === "ready") {
    lines.push("Modèle en cache : prêt (" + formatBytes(model.sizeBytes) + ").");
  } else if (model.cacheState === "downloading") {
    var progress = model.progress;
    lines.push(
      "Téléchargement en cours…" +
        (progress ? " " + formatBytes(progress.totalBytes) + " / " + formatBytes(progress.totalSizeBytes) + " (" + progress.file + ")" : "")
    );
  } else {
    lines.push("Modèle non téléchargé en cache.");
  }
  lines.push(
    model.bundledReady
      ? "Artefacts livrés avec l'extension : présents (chemin hors-ligne privilégié)."
      : "Artefacts livrés avec l'extension : absents (lance `npm run build:extension` pour les récupérer)."
  );
  if (model.lastError) lines.push(model.lastError);
  modelStatus.textContent = lines.join(" ");
  modelStatus.className = model.bundledReady ? "" : "warn";
}

function formatBytes(bytes) {
  if (typeof bytes !== "number" || !isFinite(bytes)) return "?";
  if (bytes >= 1_000_000_000) return (bytes / 1_000_000_000).toFixed(2) + " Go";
  if (bytes >= 1_000_000) return (bytes / 1_000_000).toFixed(0) + " Mo";
  return bytes + " o";
}

// ---- composer ----------------------------------------------------------------

$("composer").addEventListener("submit", function (event) {
  event.preventDefault();
  var message = $("message").value.trim();
  if (!message) return;
  var servings = Number($("servings").value);
  var count = message.match(/\b(\d+)\s*(?:personnes?|pers\.?|convives?|portions?)\b/i)
    || message.match(/\bpour\s+(\d+)\b/i);
  if (count) {
    servings = Number(count[1]);
    $("servings").value = String(servings);
  }
  var exclusionsRaw = $("exclusions").value.trim();
  var request = {
    type: "start_flow",
    message: message,
    servings: Number.isInteger(servings) && servings >= 1 ? servings : 4,
  };
  if (exclusionsRaw) {
    var exclusions = exclusionsRaw
      .split(/[,;]/)
      .map(function (item) {
        return item.trim();
      })
      .filter(function (item) {
        return item.length > 0;
      });
    if (exclusions.length) request.exclusions = exclusions;
  }
  $("message").value = "";
  sendRequest(request);
});

$("resume-btn").addEventListener("click", function () {
  sendRequest({ type: "resume" });
});

$("reset-btn").addEventListener("click", function () {
  sendRequest({ type: "reset_session" });
});

Array.prototype.forEach.call(
  document.querySelectorAll('input[name="provider"]'),
  function (radio) {
    radio.addEventListener("change", function () {
      if (radio.checked) {
        sendRequest({ type: "set_provider", providerId: radio.value });
      }
    });
  }
);

$("mistral-set").addEventListener("click", function () {
  var input = $("mistral-key");
  var key = input.value.trim();
  if (!key) return;
  input.value = "";
  sendRequest({ type: "set_mistral_key", apiKey: key });
});

$("mistral-delete").addEventListener("click", function () {
  $("mistral-key").value = "";
  sendRequest({ type: "delete_mistral_key" });
});

$("model-download").addEventListener("click", function () {
  var confirmed = window.confirm(
    "Télécharger le modèle local (environ 933 Mo) depuis huggingface.co ?\n" +
      "Chaque fichier sera vérifié contre le manifeste (taille + sha256)."
  );
  sendRequest({ type: "model_download_consent", accepted: confirmed === true });
});

$("model-clear").addEventListener("click", function () {
  sendRequest({ type: "model_cache_clear" });
});

// ---- keep-alive: hold the service worker open while the panel is open ---------

function connectKeepalive() {
  keepalivePort = chrome.runtime.connect({ name: KEEPALIVE_PORT });
  keepalivePort.onDisconnect.addListener(function () {
    keepalivePort = null;
    // Chrome closed the port (e.g. worker restart): reconnect on the next ping.
  });
}

function ping() {
  if (!keepalivePort) connectKeepalive();
  try {
    keepalivePort.postMessage({ type: "sidepanel_ping" });
  } catch (err) {
    keepalivePort = null;
    connectKeepalive();
  }
}

connectKeepalive();
setInterval(ping, 20_000);

// Initial state.
sendRequest({ type: "get_state" });
