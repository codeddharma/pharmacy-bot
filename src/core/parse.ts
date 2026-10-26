/**
 * Turns a typed message like "2 strips dolo 650, crocin x3 and eno" into
 * [{name: "dolo 650", quantity: 2}, {name: "crocin", quantity: 3}, {name: "eno", quantity: 1}].
 * No LLM involved; the engine falls back to Gemini when a line doesn't match anything.
 */
export interface TypedItem {
  raw: string;
  name: string;
  quantity: number;
}

const PACK_WORDS = "strips?|packs?|packets?|pkts?|boxe?s?|bottles?|tubes?|sachets?|pcs|nos?|pieces?";
const FILLER = new Set([
  "i", "need", "want", "please", "pls", "plz", "send", "me", "give", "buy", "order", "some", "hi", "hello",
  "hey", "can", "you", "get", "of", "the", "a", "an", "medicine", "medicines", "dawai", "dawa", "mujhe",
  "chahiye", "bhejo", "dena", "dedo", "do", "required", "also", "kindly", "sir", "madam", "bhai",
  // Question words, so "what is the price of dolo 650?" leaves just the medicine.
  "what", "whats", "is", "are", "price", "prices", "rate", "cost", "mrp", "how", "much", "kitna", "kitne",
  "kitni", "ka", "ki", "ke", "hai", "tell", "than", "cheaper", "cheap", "sasta", "available", "have", "stock",
  "urgent", "urgently", "asap", "jaldi", "now", "today",
]);

export function parseTypedList(text: string): TypedItem[] {
  const segments = text
    .split(/\n|,|;|\band\b|\baur\b|&/i)
    .map((s) => s.trim())
    .filter(Boolean);

  const items: TypedItem[] = [];
  for (const raw of segments) {
    let s = raw
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t && !FILLER.has(t.replace(/[?!.,]+$/, "")))
      .join(" ");
    let quantity: number | null = null;

    const packQty = s.match(new RegExp(`\\b(\\d{1,2})\\s*(?:x|\\*)?\\s*(?:${PACK_WORDS})\\b`));
    if (packQty) {
      quantity = Number(packQty[1]);
      s = s.replace(packQty[0], " ");
    } else {
      const timesQty = s.match(/(?:\bx|\*)\s*(\d{1,2})\b/);
      if (timesQty) {
        quantity = Number(timesQty[1]);
        s = s.replace(timesQty[0], " ");
      } else {
        const leadingQty = s.match(/^\s*(\d{1,2})\s+(?=[a-z])/);
        if (leadingQty) {
          quantity = Number(leadingQty[1]);
          s = s.slice(leadingQty[0].length);
        }
      }
    }

    const name = s.replace(new RegExp(`\\b(?:${PACK_WORDS})\\b`, "g"), " ").replace(/\s+/g, " ").trim();
    if (name.length < 2) continue;

    items.push({ raw, name, quantity: Math.min(Math.max(quantity ?? 1, 1), 20) });
  }
  return items;
}

const YES = /^(yes|y|yep|yeah|ok|okay|haan|han|ha|ji|confirm|done|sure|theek hai|thik hai)\.?!?$/i;
const NO = /^(no|n|nope|nahi|nahin|na|cancel|stop)\.?!?$/i;

export function isYes(text: string): boolean {
  return YES.test(text.trim());
}

export function isNo(text: string): boolean {
  return NO.test(text.trim());
}
