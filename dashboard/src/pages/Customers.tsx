import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MapPin, Search, Users } from "lucide-react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { toast } from "sonner";
import { Badge, ChannelBadge, KindBadge, OrderStatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/dialog";
import { Field, Input } from "@/components/ui/form";
import { Card, EmptyState, PageHeader, Skeleton, Table, Td, Th } from "@/components/ui/layout";
import { api, patch } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Consultation, Customer, Order } from "@/lib/types";
import { customerLabel, dateTime, mapsLink, money, phone, timeAgo } from "@/lib/utils";

export function CustomersPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const list = useQuery({
    queryKey: ["customers", q],
    queryFn: () => api<{ customers: Customer[]; total: number }>(`/customers?pageSize=100${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
  const openId = params.get("id") ? Number(params.get("id")) : null;

  return (
    <>
      <PageHeader title="Customers" description={list.data ? `${list.data.total} people have messaged the bot.` : undefined} />
      <div className="mb-4 max-w-xs">
        <div className="relative">
          <Search className="absolute left-3 top-2.5 size-4 text-muted" />
          <Input className="pl-9" placeholder="Name, phone or PIN code" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <Card>
        {list.isLoading ? (
          <Skeleton className="m-4 h-32" />
        ) : list.data?.customers.length === 0 ? (
          <EmptyState icon={<Users />} title="No customers yet" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Customer</Th>
                <Th>Channel</Th>
                <Th>PIN</Th>
                <Th className="text-right">Orders</Th>
                <Th className="text-right">Spent</Th>
                <Th>Last message</Th>
              </tr>
            </thead>
            <tbody>
              {list.data?.customers.map((c) => (
                <tr key={c.id} className="cursor-pointer hover:bg-surface-muted/60" onClick={() => setParams({ id: String(c.id) })}>
                  <Td>
                    <div className="flex items-center gap-2 font-medium">
                      {customerLabel(c.name, null, c.id)} {c.blocked ? <Badge tone="red">Blocked</Badge> : null}
                    </div>
                    <div className="text-xs text-muted">{phone(c.phone)}</div>
                  </Td>
                  <Td>
                    <ChannelBadge channel={c.channel} />
                  </Td>
                  <Td className="text-muted">{c.pincode ?? "–"}</Td>
                  <Td className="tabular text-right">{c.orderCount}</Td>
                  <Td className="tabular text-right">{money(c.spentPaise ?? 0)}</Td>
                  <Td className="text-muted">{timeAgo(c.lastMessageAt)}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>
      {openId ? <CustomerSheet id={openId} onClose={() => setParams({})} /> : null}
    </>
  );
}

function CustomerSheet({ id, onClose }: { id: number; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const d = useQuery({ queryKey: ["customer", id], queryFn: () => api<{ customer: Customer; orders: Order[]; consultations: Consultation[] }>(`/customers/${id}`) });
  const [edit, setEdit] = useState<{ name: string; phone: string; address: string; pincode: string } | null>(null);

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch(`/customers/${id}`, body),
    onSuccess: () => {
      toast.success("Saved.");
      setEdit(null);
      void qc.invalidateQueries({ queryKey: ["customer", id] });
      void qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const c = d.data?.customer;
  return (
    <Sheet
      open
      onOpenChange={(v) => !v && onClose()}
      title={c ? customerLabel(c.name, c.phone, c.id) : "Customer"}
      subtitle={c ? `Customer since ${dateTime(c.createdAt)}` : undefined}
      footer={
        c && can("customers.manage") ? (
          <>
            <Button variant={c.blocked ? "secondary" : "danger-outline"} onClick={() => save.mutate({ blocked: !c.blocked })}>
              {c.blocked ? "Unblock" : "Block"}
            </Button>
            <Button variant="secondary" onClick={() => setEdit({ name: c.name ?? "", phone: c.phone ?? "", address: c.address ?? "", pincode: c.pincode ?? "" })}>
              Edit
            </Button>
          </>
        ) : null
      }
    >
      {!c || !d.data ? (
        <Skeleton className="h-60" />
      ) : edit ? (
        <div className="space-y-4">
          <Field label="Name">
            <Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
          </Field>
          <Field label="Mobile">
            <Input value={edit.phone} onChange={(e) => setEdit({ ...edit, phone: e.target.value })} />
          </Field>
          <Field label="Address">
            <Input value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} />
          </Field>
          <Field label="PIN code">
            <Input value={edit.pincode} onChange={(e) => setEdit({ ...edit, pincode: e.target.value })} />
          </Field>
          <div className="flex gap-2">
            <Button
              loading={save.isPending}
              onClick={() => save.mutate({ name: edit.name || null, phone: edit.phone || null, address: edit.address || null, pincode: edit.pincode || null })}
            >
              Save
            </Button>
            <Button variant="secondary" onClick={() => setEdit(null)}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <ChannelBadge channel={c.channel} />
            {c.blocked ? <Badge tone="red">Blocked: the bot ignores them</Badge> : null}
            {c.consentAt ? <Badge tone="green">Agreed to data use</Badge> : <Badge tone="amber">Hasn't agreed yet</Badge>}
          </div>
          <dl className="space-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted">Mobile</dt>
              <dd>{phone(c.phone)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Address</dt>
              <dd>
                {c.address ? `${c.address}, ${c.pincode ?? ""}` : "–"}
                {c.address ? (
                  <a href={mapsLink(c.lat, c.lng, `${c.address} ${c.pincode ?? ""}`)} target="_blank" rel="noreferrer" className="ml-2 inline-flex items-center gap-1 text-primary">
                    <MapPin className="size-3.5" /> Map
                  </a>
                ) : null}
              </dd>
            </div>
          </dl>
          {can("inbox.view") ? (
            <Button variant="secondary" asChild>
              <Link to={`/inbox?c=${c.id}`}>Open chat</Link>
            </Button>
          ) : null}
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Orders</h4>
            {d.data.orders.length === 0 ? (
              <p className="text-sm text-muted">No orders yet.</p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {d.data.orders.map((o) => (
                  <Link key={o.id} to={`/orders?open=${o.id}`} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm hover:bg-surface-muted">
                    <span>
                      <span className="font-medium">{o.id}</span> <span className="text-muted">· {dateTime(o.createdAt)}</span>
                    </span>
                    <span className="flex items-center gap-2">
                      <span className="tabular">{money(o.totalPaise)}</span>
                      <OrderStatusBadge status={o.status} />
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </section>
          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Questions and complaints</h4>
            {d.data.consultations.length === 0 ? (
              <p className="text-sm text-muted">None.</p>
            ) : (
              <div className="space-y-2">
                {d.data.consultations.map((q) => (
                  <div key={q.id} className="rounded-lg border border-border px-3 py-2 text-sm">
                    <div className="mb-1 flex items-center gap-2">
                      <KindBadge kind={q.kind} /> <span className="text-xs text-muted">{dateTime(q.createdAt)}</span>
                    </div>
                    <div className="line-clamp-2">{q.question}</div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </Sheet>
  );
}
