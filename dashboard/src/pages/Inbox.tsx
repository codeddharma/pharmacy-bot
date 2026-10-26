import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Hand, MessagesSquare, Paperclip, Search, Send, Undo2 } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { ChannelBadge } from "@/components/badges";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/form";
import { EmptyState, Skeleton, Tabs } from "@/components/ui/layout";
import { api, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Conversation, Message } from "@/lib/types";
import { cn, customerLabel, dateTime, phone, timeAgo } from "@/lib/utils";

type Filter = "all" | "unread" | "handoff";

export function InboxPage() {
  const [params, setParams] = useSearchParams();
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const selected = params.get("c") ? Number(params.get("c")) : null;

  const list = useQuery({
    queryKey: ["inbox", filter, q],
    queryFn: () => api<{ conversations: Conversation[] }>(`/inbox?filter=${filter}${q ? `&q=${encodeURIComponent(q)}` : ""}`),
  });

  return (
    <div className="-m-4 flex h-[calc(100vh-3.5rem)] sm:-m-6">
      <div className={cn("flex w-full flex-col border-r border-border bg-surface md:w-80", selected && "hidden md:flex")}>
        <div className="space-y-3 border-b border-border p-3">
          <h1 className="text-lg font-semibold">Inbox</h1>
          <Tabs value={filter} onChange={setFilter} items={[{ value: "all", label: "All" }, { value: "unread", label: "Unread" }, { value: "handoff", label: "Taken over" }]} />
          <div className="relative">
            <Search className="absolute left-3 top-2.5 size-4 text-muted" />
            <Input className="pl-9" placeholder="Name or phone" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {list.isLoading ? (
            <div className="space-y-2 p-3">
              <Skeleton className="h-14" />
              <Skeleton className="h-14" />
            </div>
          ) : list.data?.conversations.length === 0 ? (
            <EmptyState icon={<MessagesSquare />} title="No conversations" />
          ) : (
            list.data?.conversations.map((c) => (
              <button
                key={c.customerId}
                type="button"
                onClick={() => setParams({ c: String(c.customerId) })}
                className={cn("block w-full border-b border-border px-3 py-3 text-left hover:bg-surface-muted", selected === c.customerId && "bg-primary-soft/60")}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={cn("truncate text-sm", c.unread ? "font-semibold" : "font-medium")}>{customerLabel(c.name, c.phone, c.customerId)}</span>
                  <span className="shrink-0 text-[11px] text-muted">{timeAgo(c.lastAt)}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="line-clamp-1 flex-1 text-xs text-muted">{c.lastText}</span>
                  {c.handoffUserId ? <Hand className="size-3.5 text-warning" aria-label="Taken over by staff" /> : null}
                  {c.unread ? <span className="rounded-full bg-primary px-1.5 text-[10px] font-semibold text-white">{c.unread}</span> : null}
                </div>
              </button>
            ))
          )}
        </div>
      </div>
      <div className={cn("min-w-0 flex-1", !selected && "hidden md:block")}>
        {selected ? (
          <Thread customerId={selected} onBack={() => setParams({})} />
        ) : (
          <EmptyState icon={<MessagesSquare />} title="Pick a conversation" description="Customer chats from Telegram and WhatsApp appear here as they happen." />
        )}
      </div>
    </div>
  );
}

function Thread({ customerId, onBack }: { customerId: number; onBack: () => void }) {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const bottom = useRef<HTMLDivElement>(null);
  const thread = useQuery({
    queryKey: ["thread", customerId],
    queryFn: () =>
      api<{ customer: { id: number; name: string | null; phone: string | null; channel: string; handoffUserId: number | null; blocked: boolean }; windowOpen: boolean; messages: Message[] }>(
        `/inbox/${customerId}/messages`,
      ),
  });

  useEffect(() => {
    void post(`/inbox/${customerId}/read`).then(() => qc.invalidateQueries({ queryKey: ["badges"] }));
  }, [customerId, thread.data?.messages.length, qc]);
  useEffect(() => bottom.current?.scrollIntoView({ block: "end" }), [thread.data?.messages.length]);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ["thread", customerId] });
    void qc.invalidateQueries({ queryKey: ["inbox"] });
  };
  const send = useMutation({
    mutationFn: () => post(`/inbox/${customerId}/messages`, { text }),
    onSuccess: () => {
      setText("");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const handoff = useMutation({
    mutationFn: (take: boolean) => post(`/inbox/${customerId}/${take ? "takeover" : "release"}`),
    onSuccess: (_d, take) => {
      toast.success(take ? "You've taken over. The bot won't reply until you hand it back." : "Handed back to the bot.");
      refresh();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const d = thread.data;
  if (!d) return <Skeleton className="m-4 h-40" />;
  const handled = d.customer.handoffUserId !== null;
  const mine = d.customer.handoffUserId === user?.id;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text.trim()) send.mutate();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
        <button type="button" onClick={onBack} className="text-sm text-primary md:hidden">
          Back
        </button>
        <div className="min-w-0 flex-1">
          <div className="truncate font-semibold">{customerLabel(d.customer.name, d.customer.phone, d.customer.id)}</div>
          <div className="flex items-center gap-2 text-xs text-muted">
            {phone(d.customer.phone)} <ChannelBadge channel={d.customer.channel} />
          </div>
        </div>
        {can("inbox.reply") ? (
          handled ? (
            <Button variant="secondary" size="sm" loading={handoff.isPending} onClick={() => handoff.mutate(false)}>
              <Undo2 /> Hand back to bot
            </Button>
          ) : (
            <Button size="sm" loading={handoff.isPending} onClick={() => handoff.mutate(true)}>
              <Hand /> Take over chat
            </Button>
          )
        ) : null}
      </div>

      {handled ? (
        <div className="bg-warning-soft px-4 py-2 text-xs text-warning">
          {mine ? "You're handling this chat. The bot stays quiet until you hand it back." : "Another staff member is handling this chat."}
        </div>
      ) : null}

      <div className="flex-1 space-y-2 overflow-y-auto bg-background px-4 py-4">
        {d.messages.map((m) => {
          const fromCustomer = m.direction === "in";
          return (
            <div key={m.id} className={cn("flex", fromCustomer ? "justify-start" : "justify-end")}>
              <div
                className={cn(
                  "max-w-[80%] rounded-2xl px-3.5 py-2 text-sm shadow-sm",
                  fromCustomer && "rounded-bl-sm border border-border bg-surface",
                  m.sender === "bot" && "rounded-br-sm bg-surface-muted",
                  m.sender === "staff" && "rounded-br-sm bg-primary text-primary-foreground",
                )}
              >
                <div className="whitespace-pre-wrap break-words">{m.text}</div>
                {m.hasMedia ? (
                  <a href={`/api/messages/${m.id}/media`} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs underline">
                    <Paperclip className="size-3" /> View file
                  </a>
                ) : null}
                <div className={cn("mt-1 flex items-center gap-1 text-[10px]", m.sender === "staff" ? "text-primary-foreground/80" : "text-muted")}>
                  {m.sender === "bot" ? <Bot className="size-3" /> : null}
                  {m.sender === "staff" ? m.staffName : m.sender === "bot" ? "Bot" : ""} {dateTime(m.createdAt)}
                </div>
              </div>
            </div>
          );
        })}
        <div ref={bottom} />
      </div>

      {can("inbox.reply") ? (
        <form onSubmit={submit} className="border-t border-border bg-surface p-3">
          {!d.windowOpen ? (
            <p className="mb-2 text-xs text-warning">
              This WhatsApp customer hasn't written in 24 hours, so your reply goes out as the approved template message.
            </p>
          ) : null}
          {!handled ? <p className="mb-2 text-xs text-muted">Tip: take over the chat first if you want the bot to stop replying while you talk.</p> : null}
          <div className="flex items-end gap-2">
            <Textarea
              className="min-h-11"
              rows={2}
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Type a reply…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (text.trim()) send.mutate();
                }
              }}
            />
            <Button type="submit" size="icon" aria-label="Send" loading={send.isPending} disabled={!text.trim()}>
              {send.isPending ? null : <Send />}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}

