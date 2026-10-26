import { useQueryClient } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useAuth } from "./auth";
import type { AppEvent } from "./types";

export interface Notice {
  id: number;
  at: Date;
  title: string;
  body?: string;
  href: string;
  urgent?: boolean;
}

interface LiveValue {
  notices: Notice[];
  unseen: number;
  markSeen: () => void;
  connected: boolean;
  soundOn: boolean;
  setSoundOn: (v: boolean) => void;
}

const LiveContext = createContext<LiveValue | null>(null);

/** A short two-tone chime made with the Web Audio API (no sound file needed). */
function chime(urgent = false) {
  try {
    const ctx = new AudioContext();
    const tones = urgent ? [880, 660, 880] : [660, 880];
    tones.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t = ctx.currentTime + i * 0.18;
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.2, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      osc.start(t);
      osc.stop(t + 0.17);
    });
    setTimeout(() => void ctx.close(), 1000);
  } catch {
    // Audio blocked until the user interacts with the page; the toast still shows.
  }
}

/**
 * Listens to the server's live event stream: refreshes the data on screen, and for things
 * staff must act on (new questions, new orders, messages in taken-over chats) shows a toast,
 * plays a chime and, if allowed, a browser notification.
 */
export function LiveProvider({ children }: { children: ReactNode }) {
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const [notices, setNotices] = useState<Notice[]>([]);
  const [unseen, setUnseen] = useState(0);
  const [connected, setConnected] = useState(false);
  const [soundOn, setSoundOnState] = useState(() => {
    try {
      return localStorage.getItem("dd-sound") !== "off";
    } catch {
      return true;
    }
  });
  const soundRef = useRef(soundOn);
  soundRef.current = soundOn;
  const seq = useRef(0);

  useEffect(() => {
    if (!user) return;
    const es = new EventSource("/api/events");
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);

    const notify = (n: Omit<Notice, "id" | "at">) => {
      const notice = { ...n, id: ++seq.current, at: new Date() };
      setNotices((prev) => [notice, ...prev].slice(0, 30));
      setUnseen((u) => u + 1);
      (n.urgent ? toast.warning : toast)(n.title, { description: n.body, action: { label: "Open", onClick: () => (window.location.href = n.href) } });
      if (soundRef.current) chime(n.urgent);
      if (document.hidden && "Notification" in window && Notification.permission === "granted") {
        new Notification(n.title, { body: n.body, icon: "/favicon.svg", tag: n.href });
      }
    };

    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as AppEvent;
      switch (e.type) {
        case "order.created":
        case "order.updated":
          void qc.invalidateQueries({ queryKey: ["orders"] });
          void qc.invalidateQueries({ queryKey: ["order", e.orderId] });
          void qc.invalidateQueries({ queryKey: ["deliveries"] });
          void qc.invalidateQueries({ queryKey: ["badges"] });
          void qc.invalidateQueries({ queryKey: ["stats"] });
          if (e.type === "order.updated" && e.status === "confirmed" && e.agentId === null && can("orders.manage")) {
            notify({ title: `New order ${e.orderId}`, body: "Assign a delivery agent.", href: `/orders?open=${e.orderId}` });
          }
          if (e.type === "order.updated" && e.status === "confirmed" && !can("orders.view") && e.agentId === user.id) {
            notify({ title: `Delivery assigned: ${e.orderId}`, href: "/deliveries" });
          }
          break;
        case "message.in":
        case "message.out":
          void qc.invalidateQueries({ queryKey: ["inbox"] });
          void qc.invalidateQueries({ queryKey: ["thread", e.customerId] });
          void qc.invalidateQueries({ queryKey: ["badges"] });
          if (e.type === "message.in" && e.handoff) {
            notify({ title: "New message in a chat you're handling", body: e.preview, href: `/inbox?c=${e.customerId}` });
          }
          break;
        case "consultation.created":
        case "consultation.updated":
        case "consultation.escalated":
          void qc.invalidateQueries({ queryKey: ["consultations"] });
          void qc.invalidateQueries({ queryKey: ["badges"] });
          if (e.type === "consultation.created" && can("consultations.answer")) {
            const what = e.kind === "complaint" ? "New complaint" : e.kind === "prescription" ? "Prescription to review" : "New question for the pharmacist";
            notify({ title: what, href: "/questions" });
          }
          if (e.type === "consultation.escalated" && can("consultations.answer")) {
            notify({ title: `Question #${e.id} is waiting too long`, body: "A customer is still waiting for an answer.", href: "/questions", urgent: true });
          }
          break;
        case "stock.changed":
        case "catalogue.changed":
          void qc.invalidateQueries({ queryKey: ["products"] });
          void qc.invalidateQueries({ queryKey: ["product"] });
          break;
        case "settings.changed":
          void qc.invalidateQueries({ queryKey: ["settings"] });
          void qc.invalidateQueries({ queryKey: ["shop-status"] });
          break;
      }
    };
    return () => {
      es.close();
      setConnected(false);
    };
  }, [user, qc, can]);

  const value: LiveValue = {
    notices,
    unseen,
    markSeen: () => setUnseen(0),
    connected,
    soundOn,
    setSoundOn: (v) => {
      setSoundOnState(v);
      try {
        localStorage.setItem("dd-sound", v ? "on" : "off");
      } catch {
        // storage unavailable; keep the in-memory choice
      }
      if (v) chime();
    },
  };
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): LiveValue {
  const v = useContext(LiveContext);
  if (!v) throw new Error("useLive outside LiveProvider");
  return v;
}
