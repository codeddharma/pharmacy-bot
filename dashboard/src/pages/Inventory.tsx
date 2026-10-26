import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pill, Plus, Search, Trash2 } from "lucide-react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { Badge, ScheduleBadge, StockBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Dialog, Sheet } from "@/components/ui/dialog";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { Card, EmptyState, PageHeader, Skeleton, Table, Tabs, Td, Th } from "@/components/ui/layout";
import { api, del, patch, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Batch, Product, Schedule } from "@/lib/types";
import { rupees } from "@/lib/utils";

type StockFilter = "all" | "low" | "out" | "expiring";

const CATEGORIES = [
  "pain_fever", "acidity_digestion", "hydration", "pain_topical", "cold_cough", "skin_antiseptic", "skin_antifungal",
  "vitamins_supplements", "oral_care", "allergy", "antibiotic", "gastro", "diabetes", "cardiac", "thyroid", "neuro_psych", "other",
];
const label = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

export function InventoryPage() {
  const { can } = useAuth();
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState("");
  const stock = (params.get("stock") as StockFilter) ?? "all";
  const [creating, setCreating] = useState(false);
  const openSku = params.get("sku");

  const products = useQuery({
    queryKey: ["products", stock, q],
    queryFn: () => api<{ products: Product[] }>(`/products?stock=${stock}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });

  return (
    <>
      <PageHeader
        title="Inventory"
        description="Medicines, prices and stock. The bot only sells OTC medicines with stock that isn't close to expiry."
        actions={can("inventory.manage") ? <Button onClick={() => setCreating(true)}><Plus /> Add medicine</Button> : null}
      />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <Tabs
          value={stock}
          onChange={(v) => setParams(v === "all" ? {} : { stock: v })}
          items={[
            { value: "all", label: "All" },
            { value: "low", label: "Low or out" },
            { value: "out", label: "Out of stock" },
            { value: "expiring", label: "Near expiry" },
          ]}
        />
        <div className="relative ml-auto w-full max-w-xs">
          <Search className="absolute left-3 top-2.5 size-4 text-muted" />
          <Input className="pl-9" placeholder="Name, generic, SKU" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>

      <Card>
        {products.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        ) : products.data?.products.length === 0 ? (
          <EmptyState icon={<Pill />} title="No medicines match" />
        ) : (
          <Table>
            <thead>
              <tr>
                <Th>Medicine</Th>
                <Th>Pack</Th>
                <Th>Schedule</Th>
                <Th className="text-right">MRP</Th>
                <Th>Stock</Th>
                <Th>Rack</Th>
              </tr>
            </thead>
            <tbody>
              {products.data?.products.map((p) => (
                <tr key={p.sku} className="cursor-pointer hover:bg-surface-muted/60" onClick={() => setParams({ ...(stock !== "all" ? { stock } : {}), sku: p.sku })}>
                  <Td>
                    <div className="flex items-center gap-2 font-medium">
                      {p.brand}
                      {!p.active ? <Badge tone="grey">Discontinued</Badge> : null}
                    </div>
                    <div className="text-xs text-muted">{p.generic}</div>
                  </Td>
                  <Td className="text-muted">{p.pack.label}</Td>
                  <Td>
                    <ScheduleBadge schedule={p.schedule} />
                  </Td>
                  <Td className="tabular text-right">{rupees(p.mrp)}</Td>
                  <Td>
                    <div className="flex flex-col items-start gap-1">
                      <StockBadge status={p.stockStatus} available={p.available} />
                      {p.nearExpiryPacks ? <span className="text-[11px] text-orange">{p.nearExpiryPacks} near expiry</span> : null}
                    </div>
                  </Td>
                  <Td className="text-muted">{p.rack ?? "–"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        )}
      </Card>

      {creating ? <ProductDialog onClose={() => setCreating(false)} /> : null}
      {openSku ? <ProductSheet sku={openSku} onClose={() => setParams(stock !== "all" ? { stock } : {})} /> : null}
    </>
  );
}

// ---------------------------------------------------------------- product detail and batches

function ProductSheet({ sku, onClose }: { sku: string; onClose: () => void }) {
  const { can } = useAuth();
  const qc = useQueryClient();
  const detail = useQuery({ queryKey: ["product", sku], queryFn: () => api<{ product: Product; available: number; batches: Batch[] }>(`/products/${sku}`) });
  const [editing, setEditing] = useState(false);
  const [batch, setBatch] = useState({ batchNo: "", mfg: "", exp: "", qty: "" });
  const [confirmDelete, setConfirmDelete] = useState(false);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["product", sku] });
    void qc.invalidateQueries({ queryKey: ["products"] });
  };
  const addBatch = useMutation({
    mutationFn: () => post<{ notified: number }>(`/products/${sku}/batches`, { ...batch, qty: Number(batch.qty) }),
    onSuccess: (r) => {
      toast.success(r.notified ? `Stock added. ${r.notified} waiting customers were told it's back.` : "Stock added.");
      setBatch({ batchNo: "", mfg: "", exp: "", qty: "" });
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const setQty = useMutation({
    mutationFn: ({ id, qty }: { id: number; qty: number }) => patch(`/batches/${id}`, { qty }),
    onSuccess: () => {
      toast.success("Quantity updated.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const removeBatch = useMutation({ mutationFn: (id: number) => del(`/batches/${id}`), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const removeProduct = useMutation({
    mutationFn: () => del<{ deleted: boolean }>(`/products/${sku}`),
    onSuccess: (r) => {
      toast.success(r.deleted ? "Medicine deleted." : "It has order history, so it was marked discontinued instead.");
      refresh();
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const d = detail.data;
  const p = d?.product;
  const batchValid = batch.batchNo && /^\d{4}-\d{2}$/.test(batch.mfg) && /^\d{4}-\d{2}$/.test(batch.exp) && Number(batch.qty) > 0;

  return (
    <Sheet
      open
      onOpenChange={(v) => !v && onClose()}
      title={p?.brand ?? sku}
      subtitle={p ? `${p.generic} · ${p.pack.label}` : undefined}
      footer={
        p && can("inventory.manage") ? (
          <>
            <Button variant="danger-outline" onClick={() => setConfirmDelete(true)}>
              Delete
            </Button>
            <Button variant="secondary" onClick={() => setEditing(true)}>
              Edit details
            </Button>
          </>
        ) : null
      }
    >
      {!p || !d ? (
        <Skeleton className="h-60" />
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-lg bg-surface-muted p-3">
              <div className="text-xs text-muted">Can sell</div>
              <div className="tabular text-xl font-semibold">{d.available}</div>
            </div>
            <div className="rounded-lg bg-surface-muted p-3">
              <div className="text-xs text-muted">MRP</div>
              <div className="tabular text-xl font-semibold">{rupees(p.mrp)}</div>
            </div>
            <div className="rounded-lg bg-surface-muted p-3">
              <div className="text-xs text-muted">Reorder at</div>
              <div className="tabular text-xl font-semibold">{p.reorderLevel}</div>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <ScheduleBadge schedule={p.schedule} />
            <Badge>{label(p.category)}</Badge>
            <Badge>{label(p.system)}</Badge>
            {p.schedule !== "OTC" ? <Badge tone="amber">The bot won't sell this</Badge> : null}
            {!p.verifiedPrice ? <Badge tone="orange">Price not verified</Badge> : null}
            {!p.verifiedSchedule ? <Badge tone="orange">Schedule not verified</Badge> : null}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <dt className="text-xs text-muted">Composition</dt>
              <dd>{p.composition.map((c) => `${c.name}${c.strength ? ` ${c.strength}` : ""}`).join(" + ")}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Manufacturer</dt>
              <dd>{p.manufacturer}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Max per order</dt>
              <dd>{p.maxPacksPerOrder} packs</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Rack</dt>
              <dd>{p.rack ?? "–"}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-muted">Also matches</dt>
              <dd className="text-muted">{p.aliases.join(", ") || "–"}</dd>
            </div>
            {p.notes ? (
              <div className="col-span-2">
                <dt className="text-xs text-muted">Notes</dt>
                <dd>{p.notes}</dd>
              </div>
            ) : null}
          </dl>

          <section>
            <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Batches</h4>
            {d.batches.length === 0 ? (
              <p className="text-sm text-muted">No stock.</p>
            ) : (
              <div className="divide-y divide-border rounded-lg border border-border">
                {d.batches.map((b) => (
                  <BatchRow key={b.id} b={b} editable={can("inventory.manage")} onQty={(qty) => setQty.mutate({ id: b.id, qty })} onDelete={() => removeBatch.mutate(b.id)} />
                ))}
              </div>
            )}
          </section>

          {can("inventory.manage") ? (
            <section className="rounded-lg border border-dashed border-border p-4">
              <h4 className="mb-3 text-sm font-semibold">Add stock</h4>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Batch number">
                  <Input value={batch.batchNo} onChange={(e) => setBatch({ ...batch, batchNo: e.target.value.toUpperCase() })} placeholder="DOL6K201" />
                </Field>
                <Field label="Packs">
                  <Input type="number" min={1} value={batch.qty} onChange={(e) => setBatch({ ...batch, qty: e.target.value })} />
                </Field>
                <Field label="Manufactured" hint="Month on the pack">
                  <Input type="month" value={batch.mfg} onChange={(e) => setBatch({ ...batch, mfg: e.target.value })} />
                </Field>
                <Field label="Expires" hint="Month on the pack">
                  <Input type="month" value={batch.exp} onChange={(e) => setBatch({ ...batch, exp: e.target.value })} />
                </Field>
              </div>
              <Button className="mt-3" disabled={!batchValid} loading={addBatch.isPending} onClick={() => addBatch.mutate()}>
                Add stock
              </Button>
            </section>
          ) : null}
        </div>
      )}
      {editing && p ? <ProductDialog product={p} onClose={() => setEditing(false)} /> : null}
      <Dialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${p?.brand}?`}
        description="If it was ever ordered, it's kept for order history and marked discontinued instead."
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDelete(false)}>
              Keep it
            </Button>
            <Button variant="danger" loading={removeProduct.isPending} onClick={() => removeProduct.mutate()}>
              Delete
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">Its batches and any waiting-customer requests are removed too.</p>
      </Dialog>
    </Sheet>
  );
}

function BatchRow({ b, editable, onQty, onDelete }: { b: Batch; editable: boolean; onQty: (q: number) => void; onDelete: () => void }) {
  const [qty, setQty] = useState(String(b.qty));
  return (
    <div className="flex items-center gap-3 px-3 py-2.5 text-sm">
      <div className="flex-1">
        <div className="font-medium">{b.batchNo}</div>
        <div className="text-xs text-muted">
          Mfg {b.mfg.slice(0, 7)} · Exp {b.exp.slice(0, 7)}
        </div>
      </div>
      {b.sellable ? <Badge tone="green">Sellable</Badge> : <Badge tone="orange">Near expiry</Badge>}
      {editable ? (
        <>
          <Input className="w-20 text-right" type="number" min={0} value={qty} onChange={(e) => setQty(e.target.value)} onBlur={() => Number(qty) !== b.qty && onQty(Number(qty))} aria-label="Packs" />
          <button type="button" onClick={onDelete} className="rounded p-1 text-muted hover:text-danger" aria-label="Delete batch">
            <Trash2 className="size-4" />
          </button>
        </>
      ) : (
        <span className="tabular">{b.qty}</span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- add / edit medicine

function ProductDialog({ product, onClose }: { product?: Product; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState(() => ({
    sku: product?.sku ?? "",
    brand: product?.brand ?? "",
    generic: product?.generic ?? "",
    composition: product?.composition.map((c) => `${c.name}${c.strength ? ` | ${c.strength}` : ""}`).join("\n") ?? "",
    form: product?.form ?? "tablet",
    packSize: String(product?.pack.size ?? ""),
    packUnit: product?.pack.unit ?? "tablet",
    packLabel: product?.pack.label ?? "",
    manufacturer: product?.manufacturer ?? "",
    category: product?.category ?? "other",
    system: product?.system ?? "allopathy",
    schedule: (product?.schedule ?? "OTC") as Schedule,
    mrp: String(product?.mrp ?? ""),
    maxPacksPerOrder: String(product?.maxPacksPerOrder ?? 5),
    reorderLevel: String(product?.reorderLevel ?? 5),
    rack: product?.rack ?? "",
    aliases: product?.aliases.join(", ") ?? "",
    warnings: product?.warnings.join("\n") ?? "",
    notes: product?.notes ?? "",
    active: product?.active ?? true,
    verifiedPrice: product?.verifiedPrice ?? true,
    verifiedSchedule: product?.verifiedSchedule ?? true,
  }));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const save = useMutation({
    mutationFn: () => {
      const body = {
        brand: f.brand.trim(),
        generic: f.generic.trim(),
        composition: f.composition
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [name, strength] = l.split("|").map((x) => x.trim());
            return { name: name!, strength: strength || null };
          }),
        form: f.form,
        pack: { size: Number(f.packSize), unit: f.packUnit, label: f.packLabel || `Pack of ${f.packSize} ${f.packUnit}s` },
        manufacturer: f.manufacturer.trim(),
        category: f.category,
        system: f.system,
        schedule: f.schedule,
        mrp: Number(f.mrp),
        maxPacksPerOrder: Number(f.maxPacksPerOrder),
        reorderLevel: Number(f.reorderLevel),
        rack: f.rack || null,
        aliases: f.aliases.split(",").map((a) => a.trim().toLowerCase()).filter(Boolean),
        warnings: f.warnings.split("\n").map((w) => w.trim()).filter(Boolean),
        notes: f.notes || null,
        active: f.active,
        verifiedPrice: f.verifiedPrice,
        verifiedSchedule: f.verifiedSchedule,
      };
      return product ? patch(`/products/${product.sku}`, body) : post("/products", { ...body, sku: f.sku.trim().toUpperCase() });
    },
    onSuccess: () => {
      toast.success(product ? "Medicine updated." : "Medicine added. Add its stock from the medicine's page.");
      void qc.invalidateQueries({ queryKey: ["products"] });
      void qc.invalidateQueries({ queryKey: ["product"] });
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog
      open
      wide
      onOpenChange={(v) => !v && onClose()}
      title={product ? `Edit ${product.brand}` : "Add a medicine"}
      description="Customers find it by brand, generic name and the extra names you list."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()} disabled={!f.brand || !f.generic || !f.composition || !f.mrp || !f.packSize || (!product && !f.sku)}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {!product ? (
          <Field label="SKU" hint="Capital letters, digits and dashes, e.g. DOLO650-15">
            <Input value={f.sku} onChange={set("sku")} />
          </Field>
        ) : null}
        <Field label="Brand name">
          <Input value={f.brand} onChange={set("brand")} placeholder="Dolo 650" />
        </Field>
        <Field label="Generic name">
          <Input value={f.generic} onChange={set("generic")} placeholder="paracetamol" />
        </Field>
        <Field label="Manufacturer">
          <Input value={f.manufacturer} onChange={set("manufacturer")} />
        </Field>
        <Field label="Composition" hint="One ingredient per line: name | strength" className="sm:col-span-2">
          <Textarea value={f.composition} onChange={set("composition")} placeholder={"Paracetamol | 650 mg"} />
        </Field>
        <Field label="Schedule" hint="Only OTC medicines are sold by the bot">
          <Select value={f.schedule} onChange={set("schedule")}>
            <option value="OTC">OTC (no prescription)</option>
            <option value="G">Schedule G</option>
            <option value="H">Schedule H</option>
            <option value="H1">Schedule H1</option>
            <option value="X">Schedule X</option>
          </Select>
        </Field>
        <Field label="MRP for the whole pack (₹)">
          <Input type="number" step="0.01" min={0} value={f.mrp} onChange={set("mrp")} />
        </Field>
        <Field label="Form">
          <Select value={f.form} onChange={set("form")}>
            {["tablet", "capsule", "chewable tablet", "effervescent tablet", "syrup", "oral suspension", "drops", "nasal spray", "gel", "cream", "ointment", "balm", "lozenge", "powder", "liquid", "mouthwash", "injection", "other"].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Pack size">
            <Input type="number" min={1} value={f.packSize} onChange={set("packSize")} />
          </Field>
          <Field label="Unit">
            <Input value={f.packUnit} onChange={set("packUnit")} placeholder="tablet, ml, g" />
          </Field>
        </div>
        <Field label="Pack label" hint="As customers see it">
          <Input value={f.packLabel} onChange={set("packLabel")} placeholder="Strip of 15 tablets" />
        </Field>
        <Field label="Category">
          <Select value={f.category} onChange={set("category")}>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {label(c)}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type">
          <Select value={f.system} onChange={set("system")}>
            {["allopathy", "ayurveda", "herbal", "homeopathy", "unani", "other"].map((s) => (
              <option key={s} value={s}>
                {label(s)}
              </option>
            ))}
          </Select>
        </Field>
        <div className="grid grid-cols-3 gap-2 sm:col-span-2">
          <Field label="Max packs per order">
            <Input type="number" min={0} value={f.maxPacksPerOrder} onChange={set("maxPacksPerOrder")} />
          </Field>
          <Field label="Reorder at (packs)">
            <Input type="number" min={0} value={f.reorderLevel} onChange={set("reorderLevel")} />
          </Field>
          <Field label="Rack">
            <Input value={f.rack} onChange={set("rack")} placeholder="A1" />
          </Field>
        </div>
        <Field label="Other names customers use" hint="Comma-separated, including common misspellings" className="sm:col-span-2">
          <Input value={f.aliases} onChange={set("aliases")} placeholder="dolo, dollo, pcm 650" />
        </Field>
        <Field label="Label warnings" hint="One per line; shown in the customer's cart" className="sm:col-span-2">
          <Textarea value={f.warnings} onChange={set("warnings")} />
        </Field>
        <Field label="Internal notes" className="sm:col-span-2">
          <Textarea value={f.notes} onChange={set("notes")} />
        </Field>
        <div className="space-y-1 sm:col-span-2">
          <Checkbox checked={f.active} onChange={(v) => setF({ ...f, active: v })} label="On sale" description="Untick to stop the bot offering it." />
          <Checkbox checked={f.verifiedPrice} onChange={(v) => setF({ ...f, verifiedPrice: v })} label="Price checked against the pack" />
          <Checkbox checked={f.verifiedSchedule} onChange={(v) => setF({ ...f, verifiedSchedule: v })} label="Schedule checked by a pharmacist" />
        </div>
      </div>
    </Dialog>
  );
}
