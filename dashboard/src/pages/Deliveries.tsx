import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bike, CheckCircle2, MapPin, Phone } from "lucide-react";
import { toast } from "sonner";
import { OrderStatusBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Card, EmptyState, PageHeader, Skeleton } from "@/components/ui/layout";
import { api, post } from "@/lib/api";
import type { Delivery, OrderStatus, PaymentStatus } from "@/lib/types";
import { dateTime, mapsLink, money } from "@/lib/utils";

interface MyDelivery {
  id: string;
  status: OrderStatus;
  totalPaise: number;
  paymentMethod: "upi" | "cod" | null;
  paymentStatus: PaymentStatus;
  delivery: Delivery | null;
  lines: { brand: string; packLabel: string; qty: number }[];
  etaText: string | null;
  scheduledFor: string | null;
  customerName: string | null;
  customerPhone: string | null;
  updatedAt: string;
}

/** Phone-first page for delivery agents: big buttons, call and map links. */
export function DeliveriesPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["deliveries"], queryFn: () => api<{ deliveries: MyDelivery[] }>("/me/deliveries"), refetchInterval: 60_000 });
  const update = useMutation({
    mutationFn: ({ id, status }: { id: string; status: OrderStatus }) => post<{ warning: string | null }>(`/orders/${id}/status`, { status }),
    onSuccess: (r, v) => {
      if (r.warning) toast.warning(r.warning);
      else toast.success(v.status === "delivered" ? "Marked delivered. Thank you!" : "Marked picked up. The customer has been told you're on the way.");
      void qc.invalidateQueries({ queryKey: ["deliveries"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const all = q.data?.deliveries ?? [];
  const todo = all.filter((d) => d.status !== "delivered");
  const done = all.filter((d) => d.status === "delivered").slice(0, 10);

  return (
    <div className="mx-auto max-w-xl">
      <PageHeader title="My deliveries" description="Tap Picked up when you leave the shop, and Delivered at the door." />
      {q.isLoading ? (
        <Skeleton className="h-48" />
      ) : todo.length === 0 ? (
        <Card>
          <EmptyState icon={<Bike />} title="No deliveries right now" description="New deliveries assigned to you appear here, with a sound alert." />
        </Card>
      ) : (
        <div className="space-y-4">
          {todo.map((d) => {
            const collect = d.paymentMethod === "cod" && d.paymentStatus !== "paid";
            return (
              <Card key={d.id} className="overflow-hidden">
                <div className="flex items-center justify-between border-b border-border px-4 py-3">
                  <span className="font-semibold">{d.id}</span>
                  <OrderStatusBadge status={d.status} />
                </div>
                <div className="space-y-3 p-4">
                  <div>
                    <div className="text-base font-medium">{d.delivery?.name ?? d.customerName}</div>
                    <div className="text-sm text-muted">
                      {d.delivery?.address}, {d.delivery?.pincode}
                    </div>
                    {d.scheduledFor && d.status === "confirmed" ? <div className="mt-1 text-xs text-warning">Deliver after {dateTime(d.scheduledFor)}</div> : null}
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <Button variant="secondary" size="lg" asChild>
                      <a href={`tel:${d.delivery?.phone ?? d.customerPhone}`}>
                        <Phone /> Call
                      </a>
                    </Button>
                    <Button variant="secondary" size="lg" asChild>
                      <a href={mapsLink(d.delivery?.lat, d.delivery?.lng, `${d.delivery?.address ?? ""} ${d.delivery?.pincode ?? ""}`)} target="_blank" rel="noreferrer">
                        <MapPin /> Map
                      </a>
                    </Button>
                  </div>
                  <ul className="rounded-lg bg-surface-muted px-3 py-2 text-sm">
                    {d.lines.map((l, i) => (
                      <li key={i}>
                        {l.brand} × {l.qty} <span className="text-muted">({l.packLabel.toLowerCase()})</span>
                      </li>
                    ))}
                  </ul>
                  <div className={collect ? "rounded-lg bg-warning-soft px-3 py-2 text-sm font-semibold text-warning" : "text-sm text-success"}>
                    {collect ? `Collect ${money(d.totalPaise)} in cash` : "Already paid online"}
                  </div>
                  {d.status === "out_for_delivery" ? (
                    <Button variant="success" size="lg" className="w-full" loading={update.isPending} onClick={() => update.mutate({ id: d.id, status: "delivered" })}>
                      <CheckCircle2 /> Delivered
                    </Button>
                  ) : (
                    <Button size="lg" className="w-full" loading={update.isPending} onClick={() => update.mutate({ id: d.id, status: "out_for_delivery" })}>
                      <Bike /> Picked up
                    </Button>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      )}
      {done.length ? (
        <div className="mt-8">
          <h2 className="mb-2 text-sm font-semibold text-muted">Recently delivered</h2>
          <Card className="divide-y divide-border">
            {done.map((d) => (
              <div key={d.id} className="flex justify-between px-4 py-2.5 text-sm">
                <span>
                  {d.id} · {d.delivery?.name}
                </span>
                <span className="text-muted">{dateTime(d.updatedAt)}</span>
              </div>
            ))}
          </Card>
        </div>
      ) : null}
    </div>
  );
}
