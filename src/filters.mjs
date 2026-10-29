// Pure helpers for the AC / Non-AC option (kept free of JSX so they can be unit-tested with `node --test`).
export const AC_VALUES = ["AC", "Non-AC"];        // values an owner can store on a listing ("" = not specified)
export const AC_FILTER_OPTIONS = ["Any", "AC", "Non-AC"];

/** Coerces anything (old data, user input) to "AC", "Non-AC" or "" (unspecified). */
export function normalizeAc(value) {
  if (value === true) return "AC";
  if (value === false) return "Non-AC";
  const v = String(value ?? "").trim().toLowerCase().replace(/[\s_]+/g, "-");
  if (v === "ac") return "AC";
  if (v === "non-ac" || v === "nonac") return "Non-AC";
  return "";
}

/** "Any" keeps everything. "AC"/"Non-AC" keep only listings whose owner explicitly set that value. */
export function matchesAcFilter(listing, filter) {
  if (!filter || filter === "Any") return true;
  return normalizeAc(listing?.ac) === filter;
}
