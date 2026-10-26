import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Card, CardHeader, EmptyState, PageHeader, Skeleton, Table, Tabs, Td, Th } from "@/components/ui/layout";
import { api, patch, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Permission, Role, StaffUser } from "@/lib/types";
import { phone, timeAgo } from "@/lib/utils";

interface PermissionInfo {
  key: Permission;
  description: string;
}

export function StaffPage() {
  const { can } = useAuth();
  const [tab, setTab] = useState<"people" | "roles">(can("users.manage") ? "people" : "roles");
  return (
    <>
      <PageHeader title="Staff & roles" description="Who can log in, and what each role is allowed to do." />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[...(can("users.manage") ? [{ value: "people" as const, label: "People" }] : []), ...(can("roles.manage") ? [{ value: "roles" as const, label: "Roles & permissions" }] : [])]}
        />
      </div>
      {tab === "people" ? <People /> : <Roles />}
    </>
  );
}

function usePermissions() {
  return useQuery({ queryKey: ["permissions"], queryFn: () => api<{ permissions: PermissionInfo[] }>("/permissions"), staleTime: Infinity });
}

function People() {
  const users = useQuery({ queryKey: ["users"], queryFn: () => api<{ users: StaffUser[] }>("/users") });
  const [editing, setEditing] = useState<StaffUser | "new" | null>(null);
  const [resetting, setResetting] = useState<StaffUser | null>(null);

  return (
    <Card>
      <CardHeader title="People" description="Delivery agents are staff with the Delivery agent role." action={<Button size="sm" onClick={() => setEditing("new")}><Plus /> Add person</Button>} />
      {users.isLoading ? (
        <Skeleton className="m-4 h-24" />
      ) : (
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Role</Th>
              <Th>Phone</Th>
              <Th>Status</Th>
              <Th>Last login</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {users.data?.users.map((u) => (
              <tr key={u.id} className={u.isActive ? "" : "opacity-60"}>
                <Td>
                  <div className="font-medium">{u.name}</div>
                  <div className="text-xs text-muted">{u.email}</div>
                </Td>
                <Td>
                  <div className="flex flex-wrap items-center gap-1">
                    <Badge tone="teal">{u.roleName}</Badge>
                    {u.grantPermissions.length + u.denyPermissions.length > 0 ? <Badge tone="violet">Custom permissions</Badge> : null}
                  </div>
                </Td>
                <Td className="text-muted">{phone(u.phone)}</Td>
                <Td>{!u.isActive ? <Badge>Deactivated</Badge> : u.onDuty ? <Badge tone="green">On duty</Badge> : <Badge>Off duty</Badge>}</Td>
                <Td className="text-muted">{u.lastLoginAt ? timeAgo(u.lastLoginAt) : "Never"}</Td>
                <Td className="text-right">
                  <Button variant="ghost" size="sm" onClick={() => setResetting(u)} aria-label="Reset password">
                    <KeyRound />
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(u)}>
                    Edit
                  </Button>
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
      )}
      {editing ? <UserDialog user={editing === "new" ? null : editing} onClose={() => setEditing(null)} /> : null}
      {resetting ? <ResetPassword user={resetting} onClose={() => setResetting(null)} /> : null}
    </Card>
  );
}

function UserDialog({ user, onClose }: { user: StaffUser | null; onClose: () => void }) {
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<{ roles: Role[] }>("/roles") });
  const perms = usePermissions();
  const [f, setF] = useState({
    name: user?.name ?? "",
    email: user?.email ?? "",
    phone: user?.phone ?? "",
    password: "",
    roleId: user?.roleId ? String(user.roleId) : "",
    vehicle: user?.vehicle ?? "",
    telegramChatId: user?.telegramChatId ?? "",
    isActive: user?.isActive ?? true,
    grant: new Set<Permission>(user?.grantPermissions ?? []),
    deny: new Set<Permission>(user?.denyPermissions ?? []),
  });
  const role = roles.data?.roles.find((r) => String(r.id) === f.roleId);
  const isAgent = role?.key === "delivery_agent";

  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: f.name,
        email: f.email,
        phone: f.phone || null,
        roleId: Number(f.roleId),
        vehicle: f.vehicle || null,
        telegramChatId: f.telegramChatId || null,
        grantPermissions: [...f.grant],
        denyPermissions: [...f.deny],
      };
      if (!user) return post("/users", { ...body, password: f.password });
      const isSelf = user.id === me?.id;
      return patch(`/users/${user.id}`, isSelf ? { ...body, roleId: undefined } : { ...body, isActive: f.isActive });
    },
    onSuccess: () => {
      toast.success(user ? "Saved." : "Account created. Share the email and password with them privately.");
      void qc.invalidateQueries({ queryKey: ["users"] });
      void qc.invalidateQueries({ queryKey: ["agents"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // A permission is on if the role has it and it isn't removed, or it's added for this person.
  const effective = (p: Permission) => (role?.permissions.includes(p) && !f.deny.has(p)) || f.grant.has(p);
  const flip = (p: Permission, on: boolean) => {
    const grant = new Set(f.grant);
    const deny = new Set(f.deny);
    grant.delete(p);
    deny.delete(p);
    const fromRole = !!role?.permissions.includes(p);
    if (on && !fromRole) grant.add(p);
    if (!on && fromRole) deny.add(p);
    setF({ ...f, grant, deny });
  };

  return (
    <Dialog
      open
      wide
      onOpenChange={(v) => !v && onClose()}
      title={user ? `Edit ${user.name}` : "Add a person"}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} disabled={!f.name || !f.email || !f.roleId || (!user && f.password.length < 8)} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Email (used to log in)">
          <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
        </Field>
        <Field label="Mobile" hint={isAgent ? "Customers see this number for their delivery" : undefined}>
          <Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="+919876543210" />
        </Field>
        <Field label="Role">
          <Select value={f.roleId} onChange={(e) => setF({ ...f, roleId: e.target.value })} disabled={user?.id === me?.id}>
            <option value="">Choose…</option>
            {roles.data?.roles.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </Select>
        </Field>
        {!user ? (
          <Field label="Password" hint="At least 8 characters. They can change it after logging in.">
            <Input type="text" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          </Field>
        ) : null}
        {isAgent ? (
          <Field label="Vehicle">
            <Input value={f.vehicle} onChange={(e) => setF({ ...f, vehicle: e.target.value })} placeholder="Scooter" />
          </Field>
        ) : null}
        <Field label="Telegram chat ID (optional)" hint="For alerts on Telegram. They can find it by messaging @userinfobot.">
          <Input value={f.telegramChatId} onChange={(e) => setF({ ...f, telegramChatId: e.target.value })} />
        </Field>
        {user && user.id !== me?.id ? (
          <div className="flex items-end">
            <Checkbox checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} label="Can log in" description="Untick to deactivate the account." />
          </div>
        ) : null}
      </div>

      {role ? (
        <div className="mt-6">
          <h4 className="text-sm font-semibold">Permissions</h4>
          <p className="mb-2 text-xs text-muted">
            Starts from the {role.name} role. Tick or untick to change it for this person only.
          </p>
          <div className="grid gap-1 sm:grid-cols-2">
            {perms.data?.permissions.map((p) => (
              <div key={p.key} className="flex items-start gap-1">
                <Checkbox checked={effective(p.key)} onChange={(v) => flip(p.key, v)} label={p.description} description={f.grant.has(p.key) ? "Added for this person" : f.deny.has(p.key) ? "Removed for this person" : undefined} />
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </Dialog>
  );
}

function ResetPassword({ user, onClose }: { user: StaffUser; onClose: () => void }) {
  const [password, setPassword] = useState("");
  const reset = useMutation({
    mutationFn: () => post(`/users/${user.id}/password`, { password }),
    onSuccess: () => {
      toast.success("Password changed. They've been logged out everywhere.");
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Reset ${user.name}'s password`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={password.length < 8} loading={reset.isPending} onClick={() => reset.mutate()}>
            Set password
          </Button>
        </>
      }
    >
      <Field label="New password" hint="At least 8 characters. Share it privately.">
        <Input value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
    </Dialog>
  );
}

function Roles() {
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ["roles"], queryFn: () => api<{ roles: Role[] }>("/roles") });
  const perms = usePermissions();
  const [creating, setCreating] = useState(false);
  const [newRole, setNewRole] = useState({ name: "", description: "" });

  const update = useMutation({
    mutationFn: ({ id, permissions }: { id: number; permissions: Permission[] }) => patch(`/roles/${id}`, { permissions }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["roles"] });
      void qc.invalidateQueries({ queryKey: ["me"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const create = useMutation({
    mutationFn: () => post("/roles", { ...newRole, permissions: [] }),
    onSuccess: () => {
      toast.success("Role created. Tick the permissions it should have.");
      setCreating(false);
      setNewRole({ name: "", description: "" });
      void qc.invalidateQueries({ queryKey: ["roles"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!roles.data || !perms.data) return <Skeleton className="h-60" />;
  if (roles.data.roles.length === 0) return <EmptyState icon={<ShieldCheck />} title="No roles" />;

  return (
    <Card>
      <CardHeader title="What each role can do" description="Changes apply immediately to everyone with that role." action={<Button size="sm" onClick={() => setCreating(true)}><Plus /> New role</Button>} />
      <Table>
        <thead>
          <tr>
            <Th>Permission</Th>
            {roles.data.roles.map((r) => (
              <Th key={r.id} className="text-center">
                {r.name}
                <div className="font-normal">{r.userCount} people</div>
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {perms.data.permissions.map((p) => (
            <tr key={p.key}>
              <Td>{p.description}</Td>
              {roles.data.roles.map((r) => {
                const has = r.permissions.includes(p.key);
                return (
                  <Td key={r.id} className="text-center">
                    <input
                      type="checkbox"
                      className="size-4 accent-[var(--primary)]"
                      checked={has}
                      aria-label={`${r.name}: ${p.description}`}
                      onChange={(e) => update.mutate({ id: r.id, permissions: e.target.checked ? [...r.permissions, p.key] : r.permissions.filter((x) => x !== p.key) })}
                    />
                  </Td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </Table>
      <Dialog
        open={creating}
        onOpenChange={setCreating}
        title="New role"
        footer={
          <>
            <Button variant="secondary" onClick={() => setCreating(false)}>
              Cancel
            </Button>
            <Button disabled={newRole.name.length < 2} loading={create.isPending} onClick={() => create.mutate()}>
              Create
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <Input value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} placeholder="Store keeper" />
          </Field>
          <Field label="Description">
            <Textarea value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} />
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}
