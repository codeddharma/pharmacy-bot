import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LocateFixed, Plus, Trash2 } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox, Field, Input } from "@/components/ui/form";
import { Card, CardHeader, PageHeader, Skeleton } from "@/components/ui/layout";
import { api, put } from "@/lib/api";
import type { Settings } from "@/lib/types";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <div className="p-5">{children}</div>
    </Card>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["settings"], queryFn: () => api<{ settings: Settings }>("/settings") });
  const [s, setS] = useState<Settings | null>(null);
  const [holiday, setHoliday] = useState("");
  useEffect(() => {
    if (q.data && !s) setS(structuredClone(q.data.settings));
  }, [q.data, s]);

  const save = useMutation({
    mutationFn: () => put<{ settings: Settings }>("/settings", s),
    onSuccess: (r) => {
      toast.success("Settings saved. The bot uses them straight away.");
      setS(structuredClone(r.settings));
      qc.setQueryData(["settings"], r);
      void qc.invalidateQueries({ queryKey: ["shop-status"] });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!s) return <Skeleton className="h-96" />;
  const up = (fn: (d: Settings) => void) => {
    const next = structuredClone(s);
    fn(next);
    setS(next);
  };
  const num = (v: string) => (v === "" ? 0 : Number(v));
  const dirty = JSON.stringify(s) !== JSON.stringify(q.data?.settings);

  const useMyLocation = () => {
    navigator.geolocation.getCurrentPosition(
      (pos) => up((d) => ((d.pharmacy.lat = Number(pos.coords.latitude.toFixed(6))), (d.pharmacy.lng = Number(pos.coords.longitude.toFixed(6))))),
      () => toast.error("Couldn't get your location. Type the coordinates from Google Maps instead."),
    );
  };

  return (
    <>
      <PageHeader
        title="Settings"
        description="Everything the bot tells customers about your pharmacy: hours, delivery and payments."
        actions={
          <>
            {dirty ? <span className="text-xs text-warning">Unsaved changes</span> : null}
            <Button disabled={!dirty} loading={save.isPending} onClick={() => save.mutate()}>
              Save changes
            </Button>
          </>
        }
      />
      <div className="space-y-6">
        <Section title="Pharmacy" description="Shown to customers in the bot's messages.">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Pharmacy name">
              <Input value={s.pharmacy.name} onChange={(e) => up((d) => void (d.pharmacy.name = e.target.value))} />
            </Field>
            <Field label="Main phone">
              <Input value={s.pharmacy.phone} onChange={(e) => up((d) => void (d.pharmacy.phone = e.target.value))} />
            </Field>
            <Field label="Pharmacist's phone" hint="Given out for prescription questions">
              <Input value={s.pharmacy.pharmacistPhone} onChange={(e) => up((d) => void (d.pharmacy.pharmacistPhone = e.target.value))} />
            </Field>
            <Field label="Manager's phone" hint="Given out for complaints">
              <Input value={s.pharmacy.managerPhone} onChange={(e) => up((d) => void (d.pharmacy.managerPhone = e.target.value))} />
            </Field>
            <Field label="Address" className="sm:col-span-2">
              <Input value={s.pharmacy.address} onChange={(e) => up((d) => void (d.pharmacy.address = e.target.value))} />
            </Field>
            <Field label="Latitude" hint="Needed for the delivery radius. In Google Maps, right-click the shop to copy it.">
              <Input type="number" step="0.000001" value={s.pharmacy.lat ?? ""} onChange={(e) => up((d) => void (d.pharmacy.lat = e.target.value === "" ? null : Number(e.target.value)))} />
            </Field>
            <Field label="Longitude">
              <Input type="number" step="0.000001" value={s.pharmacy.lng ?? ""} onChange={(e) => up((d) => void (d.pharmacy.lng = e.target.value === "" ? null : Number(e.target.value)))} />
            </Field>
          </div>
          <Button variant="secondary" size="sm" className="mt-3" onClick={useMyLocation}>
            <LocateFixed /> Use this device's location (stand in the shop)
          </Button>
        </Section>

        <Section title="Opening hours" description="Orders placed while closed are prepared and delivered after the next opening.">
          <div className="space-y-2">
            {s.hours.weekly.map((day, i) => (
              <div key={i} className="flex flex-wrap items-center gap-3">
                <span className="w-24 text-sm">{DAYS[i]}</span>
                <Input type="time" className="w-32" value={day.open} disabled={day.closed} onChange={(e) => up((d) => void (d.hours.weekly[i]!.open = e.target.value))} aria-label={`${DAYS[i]} opens`} />
                <span className="text-muted">to</span>
                <Input type="time" className="w-32" value={day.close} disabled={day.closed} onChange={(e) => up((d) => void (d.hours.weekly[i]!.close = e.target.value))} aria-label={`${DAYS[i]} closes`} />
                <Checkbox checked={day.closed} onChange={(v) => up((d) => void (d.hours.weekly[i]!.closed = v))} label="Closed all day" />
              </div>
            ))}
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Same-day cut-off (minutes before closing)" hint="Orders after this are delivered at the next opening.">
              <Input type="number" min={0} value={s.hours.sameDayCutoffMinutes} onChange={(e) => up((d) => void (d.hours.sameDayCutoffMinutes = num(e.target.value)))} />
            </Field>
            <div>
              <Field label="Holidays (closed dates)">
                <div className="flex gap-2">
                  <Input type="date" value={holiday} onChange={(e) => setHoliday(e.target.value)} />
                  <Button
                    variant="secondary"
                    disabled={!holiday || s.hours.holidays.includes(holiday)}
                    onClick={() => {
                      up((d) => void (d.hours.holidays = [...d.hours.holidays, holiday].sort()));
                      setHoliday("");
                    }}
                  >
                    <Plus /> Add
                  </Button>
                </div>
              </Field>
              <div className="mt-2 flex flex-wrap gap-2">
                {s.hours.holidays.map((h) => (
                  <span key={h} className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2.5 py-1 text-xs">
                    {h}
                    <button type="button" onClick={() => up((d) => void (d.hours.holidays = d.hours.holidays.filter((x) => x !== h)))} aria-label={`Remove ${h}`}>
                      <Trash2 className="size-3 text-muted hover:text-danger" />
                    </button>
                  </span>
                ))}
              </div>
            </div>
          </div>
        </Section>

        <Section title="Delivery" description="Distance is measured in a straight line from the pharmacy; road distance is usually 20–40% more.">
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Delivery radius (km)">
              <Input type="number" min={1} step="0.5" value={s.delivery.radiusKm} onChange={(e) => up((d) => void (d.delivery.radiusKm = num(e.target.value)))} />
            </Field>
            <Field label="Delivery fee (₹)">
              <Input type="number" min={0} value={s.delivery.feeRupees} onChange={(e) => up((d) => void (d.delivery.feeRupees = num(e.target.value)))} />
            </Field>
            <Field label="Free delivery from (₹)">
              <Input type="number" min={0} value={s.delivery.freeAboveRupees} onChange={(e) => up((d) => void (d.delivery.freeAboveRupees = num(e.target.value)))} />
            </Field>
          </div>
          <h4 className="mb-2 mt-5 text-xs font-semibold">Delivery time shown to customers</h4>
          <div className="space-y-2">
            {s.delivery.etaBands.map((b, i) => (
              <div key={i} className="flex items-center gap-2 text-sm">
                <span className="text-muted">Up to</span>
                <Input type="number" className="w-20" min={0.5} step="0.5" value={b.maxKm} onChange={(e) => up((d) => void (d.delivery.etaBands[i]!.maxKm = num(e.target.value)))} aria-label="Up to km" />
                <span className="text-muted">km:</span>
                <Input className="max-w-48" value={b.text} onChange={(e) => up((d) => void (d.delivery.etaBands[i]!.text = e.target.value))} aria-label="Delivery time" />
                <button type="button" disabled={s.delivery.etaBands.length === 1} onClick={() => up((d) => void d.delivery.etaBands.splice(i, 1))} aria-label="Remove band">
                  <Trash2 className="size-4 text-muted hover:text-danger" />
                </button>
              </div>
            ))}
            <Button variant="ghost" size="sm" onClick={() => up((d) => void d.delivery.etaBands.push({ maxKm: (d.delivery.etaBands.at(-1)?.maxKm ?? 0) + 5, text: "60–90 minutes" }))}>
              <Plus /> Add a band
            </Button>
          </div>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="PIN codes you deliver to" hint="Comma-separated prefixes, e.g. 380, 382. Empty means any PIN code.">
              <Input
                value={s.delivery.serviceablePincodePrefixes.join(", ")}
                onChange={(e) => up((d) => void (d.delivery.serviceablePincodePrefixes = e.target.value.split(",").map((x) => x.trim()).filter(Boolean)))}
              />
            </Field>
            <div className="flex items-end">
              <Checkbox
                checked={s.delivery.requireLocation}
                onChange={(v) => up((d) => void (d.delivery.requireLocation = v))}
                label="Require customers to share their location"
                description="Otherwise they can skip it and the PIN code is used."
              />
            </div>
          </div>
        </Section>

        <Section title="Orders and payment">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Hold stock in a cart for (minutes)">
              <Input type="number" min={5} value={s.orders.reservationMinutes} onChange={(e) => up((d) => void (d.orders.reservationMinutes = num(e.target.value)))} />
            </Field>
            <Field label="Warn about repeat orders within (minutes)" hint="0 turns the warning off">
              <Input type="number" min={0} value={s.orders.duplicateWindowMinutes} onChange={(e) => up((d) => void (d.orders.duplicateWindowMinutes = num(e.target.value)))} />
            </Field>
            <Checkbox checked={s.orders.upiEnabled} onChange={(v) => up((d) => void (d.orders.upiEnabled = v))} label="Accept UPI (Razorpay)" />
            <Checkbox checked={s.orders.codEnabled} onChange={(v) => up((d) => void (d.orders.codEnabled = v))} label="Accept cash on delivery" />
          </div>
        </Section>

        <Section title="Stock, questions and privacy">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Don't sell batches expiring within (days)">
              <Input type="number" min={0} value={s.inventory.nearExpiryDays} onChange={(e) => up((d) => void (d.inventory.nearExpiryDays = num(e.target.value)))} />
            </Field>
            <Field label="Alert managers when a question waits (minutes)">
              <Input type="number" min={1} value={s.consultations.escalateAfterMinutes} onChange={(e) => up((d) => void (d.consultations.escalateAfterMinutes = num(e.target.value)))} />
            </Field>
            <Field label="Reset an idle chat after (minutes)">
              <Input type="number" min={5} value={s.bot.sessionTimeoutMinutes} onChange={(e) => up((d) => void (d.bot.sessionTimeoutMinutes = num(e.target.value)))} />
            </Field>
            <Field label="Delete uploaded prescriptions after (days)">
              <Input type="number" min={1} value={s.bot.uploadRetentionDays} onChange={(e) => up((d) => void (d.bot.uploadRetentionDays = num(e.target.value)))} />
            </Field>
          </div>
        </Section>

        <Section
          title="WhatsApp"
          description="WhatsApp only allows free-form messages within 24 hours of the customer's last message. After that, replies go out as this approved template."
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Template name" hint="Approved in Meta Business Manager, with two variables: pharmacy name and message">
              <Input value={s.whatsapp.followUpTemplate} onChange={(e) => up((d) => void (d.whatsapp.followUpTemplate = e.target.value))} placeholder="staff_reply" />
            </Field>
            <Field label="Template language code">
              <Input value={s.whatsapp.templateLanguage} onChange={(e) => up((d) => void (d.whatsapp.templateLanguage = e.target.value))} placeholder="en" />
            </Field>
          </div>
        </Section>
      </div>
    </>
  );
}
