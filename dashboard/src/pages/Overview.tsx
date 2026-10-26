import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Clock, IndianRupee, MessageCircle, PackageX, ShoppingBag, Truck, Users } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ORDER_STATUS } from "@/components/badges";
import { Card, CardHeader, EmptyState, Kpi, PageHeader, Skeleton, Table, Tabs, Td, Th } from "@/components/ui/layout";
import { api } from "@/lib/api";
import type { OrderStatus, Stats } from "@/lib/types";
import { money, moneyShort } from "@/lib/utils";

// One series per chart, so no legend: the card title names what's plotted.
const CHART = "var(--chart)";
const axis = { stroke: "var(--muted)", fontSize: 11, tickLine: false, axisLine: false } as const;
const compactRupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", notation: "compact", maximumFractionDigits: 1 });
const grid = { stroke: "var(--border)", strokeDasharray: undefined, vertical: false } as const;

function dayLabel(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-IN", { day: "numeric", month: "short" }).format(new Date(y, m - 1, d));
}

function ChartTooltip({ active, payload, label, format }: { active?: boolean; payload?: { value: number }[]; label?: string; format: (v: number) => string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-md">
      <div className="text-muted">{label && /^\d{4}-/.test(label) ? dayLabel(label) : label}</div>
      <div className="tabular mt-0.5 font-semibold">{format(payload[0]!.value)}</div>
    </div>
  );
}

export function OverviewPage() {
  const [days, setDays] = useState<"7" | "30" | "90">("7");
  const stats = useQuery({ queryKey: ["stats", days], queryFn: () => api<Stats>(`/stats?days=${days}`), refetchInterval: 60_000 });
  const s = stats.data;

  return (
    <>
      <PageHeader
        title="Overview"
        description="Live numbers for today, and trends for the selected period."
        actions={<Tabs value={days} onChange={setDays} items={[{ value: "7", label: "7 days" }, { value: "30", label: "30 days" }, { value: "90", label: "90 days" }]} />}
      />

      {!s ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          {Array.from({ length: 8 }, (_, i) => (
            <Skeleton key={i} className="h-28" />
          ))}
        </div>
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Kpi label="Orders today" value={s.kpis.ordersToday} icon={<ShoppingBag />} hint={`${s.kpis.activeOrders} still to deliver`} />
            <Kpi label="Sales today" value={money(s.kpis.revenueTodayPaise)} icon={<IndianRupee />} hint={`${moneyShort(s.kpis.revenuePaise)} in ${days} days`} />
            <Kpi label="Average order" value={money(s.kpis.avgOrderPaise)} icon={<IndianRupee />} hint={`${s.kpis.orders} orders in ${days} days`} />
            <Kpi
              label="Open questions"
              value={s.kpis.openQuestions}
              icon={<MessageCircle />}
              tone={s.kpis.openQuestions > 0 ? "warning" : "default"}
              hint={s.kpis.avgAnswerMinutes != null ? `Answered in ${s.kpis.avgAnswerMinutes} min on average` : "No answers yet in this period"}
            />
            <Kpi
              label="Average delivery time"
              value={s.kpis.avgDeliveryMinutes != null ? `${s.kpis.avgDeliveryMinutes} min` : "–"}
              icon={<Truck />}
              hint="From confirmed to delivered"
            />
            <Kpi label="Out of stock" value={s.kpis.outOfStock} icon={<PackageX />} tone={s.kpis.outOfStock > 0 ? "danger" : "default"} hint={`${s.kpis.lowStock} more running low`} />
            <Kpi label="Batches near expiry" value={s.kpis.nearExpiry} icon={<Clock />} tone={s.kpis.nearExpiry > 0 ? "warning" : "default"} hint="Medicines with stock that can't be sold" />
            <Kpi label="New customers" value={s.kpis.newCustomers} icon={<Users />} hint={`${s.kpis.refusedPrescriptionItems} prescription items refused`} />
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <Card>
              <CardHeader title="Orders per day" description="Confirmed orders, including cash on delivery" />
              <div className="h-64 p-4">
                <ResponsiveContainer>
                  <BarChart data={s.series} margin={{ top: 16, right: 8, left: -16, bottom: 0 }}>
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="day" tickFormatter={dayLabel} {...axis} minTickGap={16} />
                    <YAxis allowDecimals={false} {...axis} />
                    <Tooltip cursor={{ fill: "var(--surface-muted)" }} content={<ChartTooltip format={(v) => `${v} orders`} />} />
                    <Bar dataKey="orders" fill={CHART} radius={[4, 4, 0, 0]} maxBarSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card>
              <CardHeader title="Sales per day" description="Order totals in ₹, GST included" />
              <div className="h-64 p-4">
                <ResponsiveContainer>
                  <AreaChart data={s.series} margin={{ top: 16, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid {...grid} />
                    <XAxis dataKey="day" tickFormatter={dayLabel} {...axis} minTickGap={16} />
                    <YAxis {...axis} tickFormatter={(v: number) => compactRupees.format(v / 100)} />
                    <Tooltip cursor={{ stroke: "var(--muted)", strokeWidth: 1 }} content={<ChartTooltip format={(v) => money(v)} />} />
                    <Area dataKey="revenuePaise" stroke={CHART} strokeWidth={2} fill={CHART} fillOpacity={0.1} activeDot={{ r: 4, stroke: "var(--surface)", strokeWidth: 2 }} dot={false} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            <Card>
              <CardHeader title="Orders by status" description={`Created in the last ${days} days`} />
              {s.byStatus.length === 0 ? (
                <EmptyState title="No orders yet" />
              ) : (
                <div className="h-64 p-4">
                  <ResponsiveContainer>
                    <BarChart
                      layout="vertical"
                      data={[...s.byStatus]
                        .sort((a, b) => b.count - a.count)
                        .map((r) => ({ ...r, label: ORDER_STATUS[r.status as OrderStatus]?.[1] ?? r.status }))}
                      margin={{ top: 0, right: 32, left: 8, bottom: 0 }}
                    >
                      <XAxis type="number" hide allowDecimals={false} />
                      <YAxis type="category" dataKey="label" width={110} {...axis} />
                      <Tooltip cursor={{ fill: "var(--surface-muted)" }} content={<ChartTooltip format={(v) => `${v} orders`} />} />
                      <Bar dataKey="count" fill={CHART} radius={[0, 4, 4, 0]} maxBarSize={20}>
                        <LabelList dataKey="count" position="right" fill="var(--muted)" fontSize={11} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </Card>

            <Card>
              <CardHeader title="How customers paid" description="Confirmed orders" />
              <div className="grid grid-cols-2 gap-4 p-5">
                {(["upi", "cod"] as const).map((m) => {
                  const n = s.payment.find((p) => p.method === m)?.count ?? 0;
                  const total = s.payment.reduce((a, p) => a + p.count, 0);
                  return (
                    <div key={m}>
                      <div className="text-xs text-muted">{m === "upi" ? "UPI" : "Cash on delivery"}</div>
                      <div className="tabular mt-1 text-2xl font-semibold">{n}</div>
                      <div className="text-xs text-muted">{total ? `${Math.round((n / total) * 100)}% of orders` : "–"}</div>
                    </div>
                  );
                })}
              </div>
              <div className="border-t border-border px-5 py-4">
                <div className="mb-2 text-xs font-medium">Deliveries by agent</div>
                {s.agents.length === 0 ? (
                  <p className="text-sm text-muted">No deliveries yet.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {s.agents.map((a) => (
                      <li key={a.name} className="flex justify-between">
                        <span>{a.name}</span>
                        <span className="tabular text-muted">{a.delivered}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>

            <Card>
              <CardHeader title="Customers waiting for stock" description="Asked to be told when it's back" action={<Link to="/inventory?stock=out" className="text-xs text-primary hover:underline">Restock</Link>} />
              {s.waitlistDemand.length === 0 ? (
                <EmptyState title="Nobody is waiting" description="Out-of-stock items customers want appear here." />
              ) : (
                <ul className="divide-y divide-border">
                  {s.waitlistDemand.map((w) => (
                    <li key={w.sku} className="flex items-center justify-between px-5 py-3 text-sm">
                      <span className="flex items-center gap-2">
                        <AlertTriangle className="size-4 text-warning" aria-hidden />
                        {w.brand}
                      </span>
                      <span className="tabular text-muted">{w.waiting} waiting</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>

          <Card>
            <CardHeader title="Top medicines" description={`By packs sold in the last ${days} days`} />
            {s.topProducts.length === 0 ? (
              <EmptyState title="No sales yet" />
            ) : (
              <Table>
                <thead>
                  <tr>
                    <Th>Medicine</Th>
                    <Th className="text-right">Packs</Th>
                    <Th className="text-right">Sales</Th>
                  </tr>
                </thead>
                <tbody>
                  {s.topProducts.map((p) => (
                    <tr key={p.sku}>
                      <Td>{p.brand}</Td>
                      <Td className="tabular text-right">{p.qty}</Td>
                      <Td className="tabular text-right">{money(p.revenuePaise)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            )}
          </Card>
        </div>
      )}
    </>
  );
}
