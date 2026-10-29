// Run with: npm test   (Node 18+, no dependencies)
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeAc, matchesAcFilter, AC_VALUES, AC_FILTER_OPTIONS } from "../src/filters.mjs";

const listings = [
  { id: 1, ac: "AC" },
  { id: 2, ac: "Non-AC" },
  { id: 3 },                 // owner did not say
  { id: 4, ac: "" },
  { id: 5, ac: true },       // legacy boolean data
  { id: 6, ac: false },
];
const ids = (f) => listings.filter((l) => matchesAcFilter(l, f)).map((l) => l.id);

test("options exposed to the UI", () => {
  assert.deepEqual(AC_VALUES, ["AC", "Non-AC"]);
  assert.deepEqual(AC_FILTER_OPTIONS, ["Any", "AC", "Non-AC"]);
});

test("normalizeAc accepts common spellings", () => {
  for (const v of ["AC", "ac", " Ac ", true]) assert.equal(normalizeAc(v), "AC", String(v));
  for (const v of ["Non-AC", "non-ac", "NON AC", "non_ac", "nonac", false]) assert.equal(normalizeAc(v), "Non-AC", String(v));
});

test("normalizeAc treats missing/unknown values as unspecified", () => {
  for (const v of [undefined, null, "", "   ", "maybe", 0, 42]) assert.equal(normalizeAc(v), "", String(v));
});

test("filter 'Any' (or empty) returns every listing", () => {
  assert.deepEqual(ids("Any"), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids(undefined), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids(""), [1, 2, 3, 4, 5, 6]);
});

test("filter 'AC' returns only explicitly-AC listings (incl. legacy true)", () => {
  assert.deepEqual(ids("AC"), [1, 5]);
});

test("filter 'Non-AC' returns only explicitly-Non-AC listings (incl. legacy false)", () => {
  assert.deepEqual(ids("Non-AC"), [2, 6]);
});

test("listings with no AC info never match a specific AC filter", () => {
  assert.equal(matchesAcFilter({ id: 3 }, "AC"), false);
  assert.equal(matchesAcFilter({ id: 3 }, "Non-AC"), false);
  assert.equal(matchesAcFilter({ ac: "" }, "AC"), false);
});

test("AC and Non-AC results never overlap and never lose listings", () => {
  const a = new Set(ids("AC")), n = new Set(ids("Non-AC"));
  for (const x of a) assert.equal(n.has(x), false);
  assert.ok(a.size + n.size <= listings.length);
});

test("null/undefined listing does not throw", () => {
  assert.equal(matchesAcFilter(null, "AC"), false);
  assert.equal(matchesAcFilter(undefined, "Any"), true);
});
