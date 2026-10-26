import { EventEmitter } from "node:events";

/** Things the dashboard shows live. The API streams these to logged-in staff (see api/events.ts). */
export type AppEvent =
  | { type: "order.created" | "order.updated"; orderId: string; status: string; agentId: number | null }
  | { type: "message.in"; customerId: number; preview: string; handoff: boolean }
  | { type: "message.out"; customerId: number }
  | { type: "consultation.created" | "consultation.updated" | "consultation.escalated"; id: number; kind: string }
  | { type: "stock.changed"; sku: string }
  | { type: "catalogue.changed" }
  | { type: "settings.changed" };

export class EventBus {
  private emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(500);
  }

  emit(event: AppEvent) {
    this.emitter.emit("event", event);
  }

  on(fn: (event: AppEvent) => void): () => void {
    this.emitter.on("event", fn);
    return () => this.emitter.off("event", fn);
  }
}
