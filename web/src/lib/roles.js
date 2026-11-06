export const ROLE_META = {
  owner: {
    label: "Owner",
    badge: "badge-green",
    summary: "Super user — boards, reports, workspace settings, and teammate roles.",
  },
  editor: {
    label: "Editor",
    badge: "",
    summary: "Can change boards, cards, reports, and AI plans.",
  },
  observer: {
    label: "Observer",
    badge: "badge-gold",
    summary: "Read-only access to boards, reports, and AI history.",
  },
};

export const ASSIGNABLE_ROLES = ["editor", "observer", "owner"];

export function roleOf(tenant) {
  return ROLE_META[tenant?.role] ? tenant.role : "editor";
}

export function canEdit(tenant) {
  return roleOf(tenant) !== "observer";
}

export function canAdmin(tenant) {
  return roleOf(tenant) === "owner";
}

export function roleMeta(tenant) {
  return ROLE_META[roleOf(tenant)];
}
