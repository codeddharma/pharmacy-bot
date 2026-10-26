import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Field, Input, Switch } from "@/components/ui/form";
import { Card, CardHeader, PageHeader } from "@/components/ui/layout";
import { patch, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";

export function ProfilePage() {
  const { user, refresh } = useAuth();
  const [details, setDetails] = useState({ name: user?.name ?? "", phone: user?.phone ?? "", telegramChatId: user?.telegramChatId ?? "" });
  const [pw, setPw] = useState({ current: "", next: "" });

  const save = useMutation({
    mutationFn: (body: Record<string, unknown>) => patch("/auth/me", body),
    onSuccess: () => {
      toast.success("Saved.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const change = useMutation({
    mutationFn: () => post("/auth/password", pw),
    onSuccess: () => {
      toast.success("Password changed. You've been logged out on other devices.");
      setPw({ current: "", next: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  if (!user) return null;
  return (
    <div className="max-w-2xl">
      <PageHeader title="My account" description={user.email} />
      <div className="space-y-6">
        <Card>
          <CardHeader title="On duty" description="Off-duty staff don't get Telegram alerts, and agents show as unavailable." />
          <div className="flex items-center justify-between p-5">
            <Switch checked={user.onDuty} onCheckedChange={(v) => save.mutate({ onDuty: v })} label={user.onDuty ? "I'm on duty" : "I'm off duty"} />
            <Badge tone="teal">{user.roleName}</Badge>
          </div>
        </Card>

        <Card>
          <CardHeader title="Details" />
          <div className="space-y-4 p-5">
            <Field label="Name">
              <Input value={details.name} onChange={(e) => setDetails({ ...details, name: e.target.value })} />
            </Field>
            <Field label="Mobile">
              <Input value={details.phone} onChange={(e) => setDetails({ ...details, phone: e.target.value })} />
            </Field>
            <Field label="Telegram chat ID" hint="Get alerts on Telegram too: message @userinfobot to find your ID, then start a chat with the pharmacy bot once.">
              <Input value={details.telegramChatId} onChange={(e) => setDetails({ ...details, telegramChatId: e.target.value })} />
            </Field>
            <Button
              loading={save.isPending}
              onClick={() => save.mutate({ name: details.name, phone: details.phone || null, telegramChatId: details.telegramChatId || null })}
            >
              Save details
            </Button>
          </div>
        </Card>

        <Card>
          <CardHeader title="Change password" />
          <div className="space-y-4 p-5">
            <Field label="Current password">
              <Input type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
            </Field>
            <Field label="New password" hint="At least 8 characters">
              <Input type="password" autoComplete="new-password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
            </Field>
            <Button disabled={!pw.current || pw.next.length < 8} loading={change.isPending} onClick={() => change.mutate()}>
              Change password
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}
