import test from "node:test";
import assert from "node:assert/strict";
import { normalizeRole, normalizePersona, describeAccount, checkLoginMatch, navIdsForRole, canAccess, audienceForPersona, ROLES, CATEGORIES } from "../src/accounts.mjs";

test("two roles and two categories exist", () => {
  assert.deepEqual(ROLES.map((r) => r.id), ["customer", "lister"]);
  assert.deepEqual(CATEGORIES.map((c) => c.id), ["student", "professional"]);
});
test("role/persona normalisation (incl. legacy accounts with no persona)", () => {
  assert.equal(normalizeRole("owner"), "lister");
  assert.equal(normalizeRole("lister"), "lister");
  assert.equal(normalizeRole("customer"), "customer");
  assert.equal(normalizeRole(undefined), "customer");
  assert.equal(normalizePersona(undefined), "student");
  assert.equal(normalizePersona("professional"), "professional");
  assert.equal(normalizePersona("weird"), "student");
});
test("describeAccount", () => {
  assert.equal(describeAccount({ role: "lister", persona: "professional" }), "Owner · Professional");
  assert.equal(describeAccount({ role: "customer" }), "Tenant · Student");
});
test("login only succeeds with the matching role AND category", () => {
  const acc = { role: "customer", persona: "professional" };
  assert.equal(checkLoginMatch(acc, "customer", "professional").ok, true);
  const wrongRole = checkLoginMatch(acc, "lister", "professional");
  assert.equal(wrongRole.ok, false);
  assert.match(wrongRole.reason, /Tenant · Professional/);
  const wrongCat = checkLoginMatch(acc, "customer", "student");
  assert.equal(wrongCat.ok, false);
  assert.match(wrongCat.reason, /Tenant · Professional/);
  assert.equal(checkLoginMatch(null, "customer", "student").ok, false);
});
test("legacy account without persona logs in as student", () => {
  assert.equal(checkLoginMatch({ role: "customer" }, "customer", "student").ok, true);
  assert.equal(checkLoginMatch({ role: "customer" }, "customer", "professional").ok, false);
});
test("navigation is role-specific", () => {
  assert.deepEqual(navIdsForRole("customer"), ["properties", "roommates", "living", "partners"]);
  assert.deepEqual(navIdsForRole("lister"), ["properties", "list"]);
  assert.equal(canAccess("lister", "roommates"), false);
  assert.equal(canAccess("customer", "list"), false);
  assert.equal(canAccess("customer", "partners"), true);
});
test("owner's default listing audience follows their category", () => {
  assert.equal(audienceForPersona("student"), "students");
  assert.equal(audienceForPersona("professional"), "professionals");
  assert.equal(audienceForPersona(undefined), "students");
});
