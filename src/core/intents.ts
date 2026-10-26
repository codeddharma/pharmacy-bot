/**
 * Keyword checks for messages that need a specific answer rather than a medicine search.
 * Deterministic on purpose: replies come from fixed, reviewed text, never from the AI.
 */
export type Intent = "complaint" | "credit" | "price" | "hours" | "urgent" | "advice";

const PATTERNS: [Intent, RegExp][] = [
  [
    "complaint",
    /\b(damaged|broken|leak(ed|ing)?|wrong (item|medicine|order|product)|not (yet )?(delivered|received)|late delivery|complain(t)?|refund|bad service|expired (medicine|strip|product|item)|missing (item|medicine))\b/i,
  ],
  ["credit", /\b(credit|udhaa?r|pay later|baad (me|mein) (pay|paise|payment))\b/i],
  ["price", /\b(price|prices|rate|cost|mrp|kitna|kitne|kitni|cheaper|cheapest|sasta|daam)\b/i],
  ["hours", /\b(timing|timings|closing time|opening time|what time|kab tak|kab khul|working hours|are you open|shop open|store open)\b/i],
  ["urgent", /\b(urgent|urgently|asap|jaldi|immediately|right now|in \d+ ?(min|mins|minutes))\b/i],
  [
    "advice",
    /\b(fever|bukhar|cough|khansi|cold|headache|sar ?dard|pain|dard|vomit(ing)?|ulti|loose motion|diarrh(o)?ea|rash|itch(ing)?|allergy|sore throat|what should i take|which medicine|kya l(u|oon|un)|kya lena|dawai batao|suggest|pregnan|side effect|safe to take|can i take|dosage|how many tablets)\b/i,
  ],
];

export function detectIntents(text: string): Set<Intent> {
  const out = new Set<Intent>();
  for (const [intent, re] of PATTERNS) if (re.test(text)) out.add(intent);
  return out;
}
