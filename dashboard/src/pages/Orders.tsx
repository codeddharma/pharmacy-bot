import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardList, ExternalLink, MapPin, Phone, Search } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { Badge, ChannelBadge, OrderStatusBadge, PaymentBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Card, EmptyState, PageHeader, Skeleton, Table, Tabs, Td, Th } from "@/components/ui/layout";
import { api, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Agent, Order, OrderEvent, OrderStatus } from "@/lib/types";
import { dateTime, mapsLink, money, phone, timeAgo } from "@/lib/utils";

type View = "active" | "unassigned" | "all" | "closed";

/** Staff actions succeed even if the customer can't be messaged; `warning` says so. */
interface StaffResult {
  order: Order;
  warning: string | null;
}

const VIEW_QUERY: Record<View, string> = {
  active: "status=confirmed,preparing,out_for_delivery",
  unassigned: "status=confirmed",
  all: "",
  closed: "status=delivered,cancelled,expired",
};

const NEXT: Partial<Record<OrderStatus, { to: OrderStatus; label: string }[]>> = {
  confirmed: [
    { to: "preparing", label: "Start preparing" },
    { to: "out_for_delivery", label: "Out for delivery" },
  ],
  preparing: [{ to: "out_for_delivery", label: "Out for delivery" }],
  out_for_delivery: [{ to: "delivered", label: "Mark delivered" }],
};

export function OrdersPage() {
  const [params, setParams] = useSearchParams();
  const [view, setView] = useState<View>("active");
  const [q, setQ] = useState("");
  const openId = params.get("open");

  const orders = useQuery({
    queryKey: ["orders", view, q],
    queryFn: () => api<{ orders: Order[]; total: number }>(`/orders?pageSize=100&${VIEW_QUERY[view]}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });
  const list = (orders.data?.orders ?? []).filter((o) => view !== "unassigned" || o.agentId === null);

  return (
    <>
      <PageHeader title="Orders" description="New orders appear here the moment they're paid or confirmed for cash on delivery." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs
          value={view}
          onChange={setView}
          items={[
            { value: "active", label: "To deliver" },
            { value: "unassigned", label: "Needs an agent" },
            { value: "closed", label: "Finished" },
            { value: "all", label: "All" },
          ]}
        />
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="absolute left-3 top-2.5 size-4 text-muted" />
          <Input className="pl-9" placeholder="Order ID, name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <Card>
        {orders.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : list.length === 0 ? (
          <EmptyState icon={<ClipboardList />} title="No orders here" description="Orders customers confirm on Telegram or WhatsApp show up here." />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Order</Th>
                <Th>Customer</Th>
                <Th>Items</Th>
                <Th className="text-right">Total</Th>
                <Th>Payment</Th>
                <Th>Status</Th>
                <Th>Agent</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((o) => (
                <tr key={o.id} className="cursor-pointer hover:bg-surface-muted/60" onClick={() => setParams({ open: o.id })}>
                  <Td>
                    <div className="whitespace-nowrap font-medium">{o.id}</div>
                    <div className="text-xs text-muted">{timeAgo(o.createdAt)}</div>
                  </Td>
                  <Td>
                    <div>{o.customerName ?? "–"}</div>
                    <div className="whitespace-nowrap text-xs text-muted">{phone(o.customerPhone)}</div>
                  </Td>
                  <Td className="max-w-56 truncate text-muted">{o.lines.map((l) => `${l.brand} × ${l.qty}`).join(", ")}</Td>
                  <Td className="tabular text-right">{money(o.totalPaise)}</Td>
                  <Td>
                    <PaymentBadge status={o.paymentStatus} method={o.paymentMethod} />
                  </Td>
                  <Td>
                    <div className="flex flex-col items-start gap-1">
                      <OrderStatusBadge status={o.status} />
                      {o.scheduledFor && o.status === "confirmed" ? <span className="text-[11px] text-warning">For {dateTime(o.scheduledFor)}</span> : null}
                    </div>
                  </Td>
                  <Td>{o.agentName ?? (o.status === "confirmed" ? <Badge tone="amber">Not assigned</Badge> : "–")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {openId ? <OrderSheet id={openId} onClose={() => setParams({})} /> : null}
    </>
  );
}

function OrderSheet({ id, onClose }: { id: string; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const detail = useQuery({
    queryKey: ["order", id],
    queryFn: () =>
      api<{ order: Order; agent: { id: number; name: string; phone: string | null } | null; customer: { id?: number; name: string | null; phone: string | null; channel?: string }; events: OrderEvent[] }>(`/orders/${id}`),
  });
  const agents = useQuery({ queryKey: ["agents"], queryFn: () => api<{ agents: Agent[] }>("/agents"), enabled: can("orders.manage") });
  const [agentId, setAgentId] = useState<string>("");
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState("");

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["order", id] });
    void qc.invalidateQueries({ queryKey: ["orders"] });
    void qc.invalidateQueries({ queryKey: ["badges"] });
  };
  const assign = useMutation({
    mutationFn: () => post<StaffResult>(`/orders/${id}/assign`, { agentId: Number(agentId) }),
    onSuccess: (r) => {
      if (r.warning) toast.warning(r.warning);
      else toast.success("Agent assigned. The customer has been told who's delivering.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const status = useMutation({
    mutationFn: (to: OrderStatus) => post<StaffResult>(`/orders/${id}/status`, { status: to }),
    onSuccess: (r) => {
      if (r.warning) toast.warning(r.warning);
      else toast.success("Status updated. The customer has been notified.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const cancel = useMutation({
    mutationFn: () => post<StaffResult>(`/orders/${id}/cancel`, { reason }),
    onSuccess: (r) => {
      if (r.warning) toast.warning(r.warning);
      else toast.success("Order cancelled. Stock is back on the shelf.");
      setCancelOpen(false);
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const d = detail.data;
  const o = d?.order;
  const canCancel = o && can("orders.manage") && !["cancelled", "expired", "delivered"].includes(o.status);

  return (
    <Sheet
      open
      onOpenChange={(v) => !v && onClose()}
      title={`Order ${id}`}
      subtitle={o ? `Placed ${dateTime(o.createdAt)}` : undefined}
      footer={
        o ? (
          <>
            {canCancel ? (
              <Button variant="danger-outline" onClick={() => setCancelOpen(true)}>
                Cancel order
              </Button>
            ) : null}
            {can("orders.manage")
              ? (NEXT[o.status] ?? []).map((n) => (
                  <Button key={n.to} loading={status.isPending && status.variables === n.to} onClick={() => status.mutate(n.to)}>
                    {n.label}
                  </Button>
                ))
              : null}
          </>
        ) : null
      }
    >
      {!o || !d ? (
        <Skeleton className="h-60" />
      ) : (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <OrderStatusBadge status={o.status} />
            <PaymentBadge status={o.paymentStatus} method={o.paymentMethod} />
            {d.customer.channel ? <ChannelBadge channel={d.customer.channel} /> : null}
          </div>

          {o.scheduledFor && ["confirmed", "preparing"].includes(o.status) ? (
            <div className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">Placed while closed: prepare it at {dateTime(o.scheduledFor)}.</div>
          ) : null}

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Items</h4>
            <div className="divide-y divide-border rounded-lg border border-border">
              {o.lines.map((l) => (
                <div key={l.sku} className="flex justify-between gap-3 px-3 py-2.5">
                  <div>
                    <div className="font-medium">
                      {l.brand} <span className="text-muted">× {l.qty}</span>
                    </div>
                    <div className="text-xs text-muted">{l.packLabel}</div>
                    {l.batches?.length ? <div className="mt-0.5 text-xs text-muted">Batch {l.batches.map((b) => `${b.batch} (exp ${b.exp}) × ${b.qty}`).join(", ")}</div> : null}
                    {l.note ? <div className="mt-0.5 text-xs text-warning">{l.note}</div> : null}
                  </div>
                  <div className="tabular text-right">{money(l.lineTotalPaise)}</div>
                </div>
              ))}
              <div className="space-y-1 bg-surface-muted/50 px-3 py-2.5 text-sm">
                <div className="flex justify-between text-muted">
                  <span>Subtotal</span>
                  <span className="tabular">{money(o.subtotalPaise)}</span>
                </div>
                <div className="flex justify-between text-muted">
                  <span>Delivery</span>
                  <span className="tabular">{o.deliveryFeePaise ? money(o.deliveryFeePaise) : "Free"}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Total</span>
                  <span className="tabular">{money(o.totalPaise)}</span>
                </div>
              </div>
            </div>
            {o.excluded.length ? (
              <div className="mt-2 text-xs text-muted">Not included: {o.excluded.map((e) => `${e.name} (${e.reason})`).join("; ")}</div>
            ) : null}
          </section>

          {o.delivery ? (
            <section>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Delivery</h4>
              <div className="space-y-1.5 text-sm">
                <div className="font-medium">{o.delivery.name}</div>
                <a href={`tel:${o.delivery.phone}`} className="flex items-center gap-1.5 text-primary">
                  <Phone className="size-3.5" /> {phone(o.delivery.phone)}
                </a>
                <div>
                  {o.delivery.address}, {o.delivery.pincode}
                </div>
                <a href={mapsLink(o.delivery.lat, o.delivery.lng, `${o.delivery.address} ${o.delivery.pincode}`)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-primary">
                  <MapPin className="size-3.5" /> Open in Maps {o.delivery.distanceKm != null ? `· ${o.delivery.distanceKm} km` : ""} <ExternalLink className="size-3" />
                </a>
                {o.etaText ? <div className="text-muted">Promised: {o.etaText}</div> : null}
              </div>
            </section>
          ) : null}

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Delivery agent</h4>
            {d.agent ? (
              <div className="mb-2 text-sm">
                {d.agent.name} · {phone(d.agent.phone)}
              </div>
            ) : (
              <p className="mb-2 text-sm text-muted">Not assigned yet.</p>
            )}
            {can("orders.manage") && ["confirmed", "preparing", "out_for_delivery"].includes(o.status) ? (
              <div className="flex gap-2">
                <Select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
                  <option value="">Choose an agent…</option>
                  {agents.data?.agents.map((a) => (
                    <option key={a.id} value={a.id}>
                      {`${a.name}${a.onDuty ? "" : " (off duty)"} · ${a.activeOrders} active`}
                    </option>
                  ))}
                </Select>
                <Button disabled={!agentId} loading={assign.isPending} onClick={() => assign.mutate()}>
                  {d.agent ? "Reassign" : "Assign"}
                </Button>
              </div>
            ) : null}
          </section>

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">History</h4>
            <ol className="space-y-2 border-l border-border pl-4">
              {d.events.map((e) => (
                <li key={e.id} className="relative text-sm">
                  <span className="absolute -left-[21px] top-1.5 size-2.5 rounded-full border-2 border-surface bg-primary" />
                  <div>
                    <span className="font-medium">{e.note ?? e.status.replace(/_/g, " ")}</span>
                    {e.userName ? <span className="text-muted"> · {e.userName}</span> : null}
                  </div>
                  <div className="text-xs text-muted">{dateTime(e.at)}</div>
                </li>
              ))}
            </ol>
          </section>
          {o.paymentId ? <p className="text-xs text-muted">Payment reference: {o.paymentId}{o.refundId ? ` · Refund: ${o.refundId}` : ""}</p> : null}
        </div>
      )}

      <Dialog
        open={cancelOpen}
        onOpenChange={setCancelOpen}
        title={`Cancel order ${id}?`}
        description={o?.paymentStatus === "paid" ? "The customer paid by UPI, so a full refund will be started automatically." : "The stock goes back on the shelf and the customer is told."}
        footer={
          <>
            <Button variant="secondary" onClick={() => setCancelOpen(false)}>
              Keep order
            </Button>
            <Button variant="danger" disabled={reason.trim().length < 3} loading={cancel.isPending} onClick={() => cancel.mutate()}>
              Cancel order
            </Button>
          </>
        }
      >
        <Field label="Reason (sent to the customer)">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Customer asked to cancel" />
        </Field>
      </Dialog>
    </Sheet>
  );
}
