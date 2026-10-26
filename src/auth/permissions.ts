/**
 * Every permission the dashboard and API check. Roles are named sets of these, and each
 * user can have extra permissions granted or removed on top of their role.
 */
export const PERMISSIONS = {
  "stats.view": "See dashboard statistics",
  "orders.view": "See all orders",
  "orders.manage": "Assign agents, change order status, cancel orders",
  "orders.refund": "Refund UPI payments",
  "deliveries.own": "See and update orders assigned to me (delivery agents)",
  "inventory.view": "See medicines and stock",
  "inventory.manage": "Add, edit and delete medicines, batches and interaction rules",
  "customers.view": "See customers",
  "customers.manage": "Edit and block customers",
  "inbox.view": "Read customer conversations",
  "inbox.reply": "Reply to customers and take over chats",
  "consultations.view": "See pharmacist questions and complaints",
  "consultations.answer": "Answer pharmacist questions and complaints",
  "hours.toggle": "Open or close the shop now",
  "settings.manage": "Change pharmacy settings, hours and delivery rules",
  "users.manage": "Add and edit staff accounts",
  "roles.manage": "Create roles and change their permissions",
  "audit.view": "See the activity log",
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export function isPermission(p: string): p is Permission {
  return p in PERMISSIONS;
}

export const DEFAULT_ROLES: { key: string; name: string; description: string; permissions: Permission[] }[] = [
  {
    key: "admin",
    name: "Admin",
    description: "Full access, including staff accounts and roles.",
    permissions: ALL_PERMISSIONS,
  },
  {
    key: "manager",
    name: "Manager",
    description: "Runs the pharmacy day to day: stock, orders, agents, customers and settings.",
    permissions: [
      "stats.view", "orders.view", "orders.manage", "orders.refund", "inventory.view", "inventory.manage",
      "customers.view", "customers.manage", "inbox.view", "inbox.reply", "consultations.view",
      "consultations.answer", "hours.toggle", "settings.manage",
    ],
  },
  {
    key: "pharmacist",
    name: "Pharmacist",
    description: "Answers customer questions and reviews prescriptions.",
    permissions: [
      "stats.view", "orders.view", "inventory.view", "inventory.manage", "customers.view", "inbox.view",
      "inbox.reply", "consultations.view", "consultations.answer",
    ],
  },
  {
    key: "delivery_agent",
    name: "Delivery agent",
    description: "Sees and updates only the deliveries assigned to them.",
    permissions: ["deliveries.own"],
  },
];

export function effectivePermissions(rolePermissions: string[], grant: string[], deny: string[]): Permission[] {
  const set = new Set(rolePermissions.filter(isPermission));
  for (const p of grant) if (isPermission(p)) set.add(p);
  for (const p of deny) set.delete(p as Permission);
  return [...set];
}
