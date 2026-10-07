/**
 * Who may do what in an organization (pure; importable anywhere). Roles are ordered: an
 * operator may do what a viewer may, an admin what an operator may.
 *
 *   VIEWER    sees sites, agents, PLCs, live values, events and alarms
 *   OPERATOR  also sends commands and setpoints to writable tags (TASK-905)
 *   ADMIN     also manages sites, agents, PLC registrations and users
 */
export const ROLES = ["VIEWER", "OPERATOR", "ADMIN"] as const;
export type Role = (typeof ROLES)[number];

export const PERMISSIONS = {
  view: "VIEWER",
  command: "OPERATOR",
  manageSites: "ADMIN",
  manageUsers: "ADMIN",
} as const satisfies Record<string, Role>;

export type Permission = keyof typeof PERMISSIONS;

const rank = (role: Role) => ROLES.indexOf(role);

export function can(role: Role | null | undefined, permission: Permission): boolean {
  return role != null && rank(role) >= rank(PERMISSIONS[permission]);
}

export const ROLE_LABELS: Record<Role, string> = { VIEWER: "Viewer", OPERATOR: "Operator", ADMIN: "Admin" };
