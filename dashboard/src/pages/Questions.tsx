import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Clock, MessageCircle, Paperclip, UserCheck } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { toast } from "sonner";
import { Badge, ChannelBadge, KindBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/form";
import { Card, EmptyState, PageHeader, Skeleton, Tabs } from "@/components/ui/layout";
import { api, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Consultation } from "@/lib/types";
import { customerLabel, dateTime, minutesSince, timeAgo } from "@/lib/utils";

type Status = "open" | "answered" | "closed" | "all";

export function QuestionsPage() {
  const [status, setStatus] = useState<Status>("open");
  const q = useQuery({
    queryKey: ["consultations", status],
    queryFn: () => api<{ consultations: Consultation[] }>(`/consultations?status=${status}`),
    refetchInterval: 30_000,
  });

  return (
    <>
      <PageHeader
        title="Questions"
        description="Customers' questions for the pharmacist, prescriptions to review and complaints. Your answer goes straight to their chat."
        actions={<Tabs value={status} onChange={setStatus} items={[{ value: "open", label: "Waiting" }, { value: "answered", label: "Answered" }, { value: "closed", label: "Closed" }, { value: "all", label: "All" }]} />}
      />
      {q.isLoading ? (
        <Skeleton className="h-40" />
      ) : q.data?.consultations.length === 0 ? (
        <Card>
          <EmptyState icon={<MessageCircle />} title={status === "open" ? "No one is waiting" : "Nothing here"} description="New questions arrive with a sound alert." />
        </Card>
      ) : (
        <div className="space-y-4">
          {q.data?.consultations.map((c) => (
            <QuestionCard key={c.id} c={c} />
          ))}
        </div>
      )}
    </>
  );
}

function QuestionCard({ c }: { c: Consultation }) {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const [answer, setAnswer] = useState("");
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["consultations"] });
    void qc.invalidateQueries({ queryKey: ["badges"] });
  };
  const claim = useMutation({ mutationFn: () => post(`/consultations/${c.id}/claim`), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });
  const send = useMutation({
    mutationFn: () => post(`/consultations/${c.id}/answer`, { answer }),
    onSuccess: () => {
      toast.success("Answer sent to the customer.");
      setAnswer("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const close = useMutation({ mutationFn: () => post(`/consultations/${c.id}/close`), onSuccess: refresh, onError: (e: Error) => toast.error(e.message) });

  const waiting = minutesSince(c.createdAt);
  const canAnswer = can("consultations.answer") && c.status !== "closed";

  return (
    <Card className={c.escalatedAt && c.status === "open" ? "border-danger/50" : undefined}>
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
        <span className="font-semibold">#{c.id}</span>
        <KindBadge kind={c.kind} />
        <ChannelBadge channel={c.channel} />
        {c.status === "open" ? (
          <Badge tone={c.escalatedAt ? "red" : "amber"}>
            <Clock className="size-3" /> Waiting {waiting < 60 ? `${waiting} min` : timeAgo(c.createdAt)}
          </Badge>
        ) : (
          <Badge tone="green">
            <CheckCircle2 className="size-3" /> {c.status === "answered" ? "Answered" : "Closed"}
          </Badge>
        )}
        <span className="ml-auto text-xs text-muted">
          {customerLabel(c.customerName, c.customerPhone, c.customerId)} ·{" "}
          <Link to={`/inbox?c=${c.customerId}`} className="text-primary hover:underline">
            open chat
          </Link>
        </span>
      </div>
      <div className="space-y-4 p-5">
        <p className="whitespace-pre-wrap text-sm">{c.question}</p>
        {c.hasMedia ? (
          <a href={`/api/consultations/${c.id}/media`} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">
            <Paperclip className="size-4" /> View the customer's prescription
          </a>
        ) : null}
        {c.answer ? (
          <div className="rounded-lg bg-primary-soft/60 px-3 py-2 text-sm">
            <div className="mb-1 text-xs text-muted">
              Answered by {c.answeredByName ?? "staff"} · {dateTime(c.answeredAt)}
            </div>
            <div className="whitespace-pre-wrap">{c.answer}</div>
          </div>
        ) : null}
        {canAnswer ? (
          <div className="space-y-2">
            <Textarea
              value={answer}
              onChange={(e) => setAnswer(e.target.value)}
              placeholder={c.kind === "complaint" ? "Reply to the customer about their complaint…" : "Write your answer. It's sent to the customer's chat as a reply from the pharmacist."}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button disabled={answer.trim().length < 2} loading={send.isPending} onClick={() => send.mutate()}>
                Send answer
              </Button>
              {c.assignedUserId !== user?.id && c.status === "open" ? (
                <Button variant="secondary" loading={claim.isPending} onClick={() => claim.mutate()}>
                  <UserCheck /> I'll take this
                </Button>
              ) : null}
              {c.assigneeName ? <span className="text-xs text-muted">Taken by {c.assigneeName}</span> : null}
              <Button variant="ghost" className="ml-auto" loading={close.isPending} onClick={() => close.mutate()}>
                Close without answering
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  );
}
