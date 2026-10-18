import { describe, expect, it } from "vitest";
import { sanitize } from "../src/sanitizer.js";

const FAKE_MISTRAL_KEY = "sk-FAKEfakefakefakefakeKEY1234567890";

describe("sanitizer de rapports (ticket #46)", () => {
  it(" laisse intact une structure sans secret", () => {
    const value = { a: 1, list: [{ b: "texte" }, true, null] };
    expect(sanitize(value)).toEqual({ a: 1, list: [{ b: "texte" }, true, null] });
  });

  it(" masque une valeur secrète passée en paramètre, partout dans la structure", () => {
    const value = {
      key: FAKE_MISTRAL_KEY,
      nested: { deeper: [`Bearer ${FAKE_MISTRAL_KEY}`] },
      message: `échec avec la clé ${FAKE_MISTRAL_KEY} en clair`,
    };
    const sanitized = sanitize(value, [FAKE_MISTRAL_KEY]) as Record<string, unknown>;
    expect(JSON.stringify(sanitized)).not.toContain(FAKE_MISTRAL_KEY);
    expect(sanitized.key).toBe("[masqué]");
  });

  it(" masque les clés au format sk-… même sans liste de secrets", () => {
    const value = { text: `réponse contenant ${FAKE_MISTRAL_KEY} dans un message` };
    const sanitized = JSON.stringify(sanitize(value));
    expect(sanitized).not.toContain(FAKE_MISTRAL_KEY);
    expect(sanitized).toContain("[masqué]");
  });

  it(" masque les jetons Bearer", () => {
    const value = { header: "Authorization: Bearer abc.def.ghi-jkl_mno123456789" };
    const sanitized = JSON.stringify(sanitize(value));
    expect(sanitized).not.toContain("abc.def.ghi-jkl_mno123456789");
    expect(sanitized).toContain("[masqué]");
  });

  it(" masque les en-têtes Authorization et cookie par nom de clé", () => {
    const value = {
      headers: {
        Authorization: "quelque chose de secret",
        "Set-Cookie": "session=abc123; HttpOnly",
        "x-api-key": "secret-x",
        "Content-Type": "application/json",
      },
    };
    const sanitized = sanitize(value) as {
      headers: Record<string, unknown>;
    };
    expect(sanitized.headers["Authorization"]).toBe("[masqué]");
    expect(sanitized.headers["Set-Cookie"]).toBe("[masqué]");
    expect(sanitized.headers["x-api-key"]).toBe("[masqué]");
    expect(sanitized.headers["Content-Type"]).toBe("application/json");
  });

  it(" masque les clés api_key/access_token sensibles (casse insensible)", () => {
    const value = { API_KEY: "s3cret", access_token: "tok-42", model_version: "1.0" };
    const sanitized = sanitize(value) as Record<string, unknown>;
    expect(sanitized["API_KEY"]).toBe("[masqué]");
    expect(sanitized["access_token"]).toBe("[masqué]");
    expect(sanitized["model_version"]).toBe("1.0");
  });

  it(" est pur : ne modifie pas la valeur d'entrée", () => {
    const value = { key: FAKE_MISTRAL_KEY, list: [FAKE_MISTRAL_KEY] };
    const copy = JSON.parse(JSON.stringify(value));
    sanitize(value, [FAKE_MISTRAL_KEY]);
    expect(value).toEqual(copy);
  });

  it(" traverse tableaux, objets imbriqués et chaînes imbriquées", () => {
    const value = {
      trace: [
        { type: "model_text", text: `modèle dit : ${FAKE_MISTRAL_KEY}` },
        { type: "tool_result", output: { nested: { deep: [`Bearer ${FAKE_MISTRAL_KEY}`] } } },
      ],
    };
    const sanitized = JSON.stringify(sanitize(value, [FAKE_MISTRAL_KEY]));
    expect(sanitized).not.toContain(FAKE_MISTRAL_KEY);
    expect(sanitized).not.toContain("Bearer sk-");
  });

  it(" ignore les secrets vides ou trop courts pour être significatifs", () => {
    const value = { a: "texte ordinaire", b: 42 };
    expect(sanitize(value, ["", "ab"])).toEqual(value);
  });
});
