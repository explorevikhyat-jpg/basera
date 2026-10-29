// Role + category architecture (pure helpers, unit-tested with `node --test`).
//
//   ROLE      tenant  | owner              (stored internally as "customer" | "lister" for backward compatibility)
//   CATEGORY  student | professional      (tenant: "I am a…"  /  owner: "I list for…")
//
// Role + category are chosen once at sign-up, saved on the account, and then drive the whole UI.
export const ROLES = [
  { id: "customer", label: "Tenant", short: "Tenant", blurb: "I'm looking for a room, flat or flatmate." },
  { id: "lister", label: "Owner", short: "Owner", blurb: "I have a property to rent out." },
];
export const CATEGORIES = [
  { id: "student", label: "Student", plural: "students", listingAudience: "students" },
  { id: "professional", label: "Professional", plural: "working professionals", listingAudience: "professionals" },
];

export const normalizeRole = (v) => (v === "lister" || v === "owner" ? "lister" : "customer");
/** Older accounts have no category -> default to student. */
export const normalizePersona = (v) => (v === "professional" ? "professional" : "student");

export const roleLabel = (role) => (normalizeRole(role) === "lister" ? "Owner" : "Tenant");
export const personaLabel = (p) => (normalizePersona(p) === "professional" ? "Professional" : "Student");
export const describeAccount = (a) => `${roleLabel(a?.role)} · ${personaLabel(a?.persona)}`;

/** What a listing owner's default "preferred tenants" should be, given their category. */
export const audienceForPersona = (p) => (normalizePersona(p) === "professional" ? "professionals" : "students");

/**
 * Login must be done through the matching role + category. Returns { ok:true } or { ok:false, reason }.
 * The reason tells the person exactly which combination their number is registered under.
 */
export function checkLoginMatch(account, role, persona) {
  if (!account) return { ok: false, reason: "No account found with this number — sign up instead." };
  const accRole = normalizeRole(account.role);
  const accPersona = normalizePersona(account.persona);
  if (accRole !== normalizeRole(role) || accPersona !== normalizePersona(persona)) {
    return { ok: false, reason: `This number is registered as ${describeAccount({ role: accRole, persona: accPersona })}. Choose that option above to log in.` };
  }
  return { ok: true };
}

/** Which sections each role can see. Everything else in the app is gated by these. */
export const NAV_BY_ROLE = {
  customer: ["properties", "roommates", "living", "partners"],
  lister: ["properties", "list"],
};
export const navIdsForRole = (role) => NAV_BY_ROLE[normalizeRole(role)];
export const canAccess = (role, tab) => navIdsForRole(role).includes(tab);
