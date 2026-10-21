import Fuse from "fuse.js";
import type { Product } from "../types.ts";

/** Prescription shorthand that comes before the medicine name ("Tab. Dolo 650"). */
const PREFIX = /^(tab|tabs|tablet|cap|caps|capsule|syp|syr|syrup|inj|oint|crm|susp|drops?)\b\.?\s*/;
const UNIT_TOKENS = new Set(["mg", "mcg", "g", "gm", "ml", "iu", "%", "w/w", "w/v"]);
/**
 * Suffixes Indian brands use for a different formulation ("Pan-D" is pantoprazole +
 * domperidone, not Pan 40). If the customer writes one that the product's name doesn't
 * have, the match is not exact and the customer has to pick.
 */
const VARIANT_TOKENS = new Set([
  "d", "dsr", "ls", "lc", "mr", "sp", "plus", "forte", "cv", "od", "xr", "sr", "er", "am", "h", "m",
  "p", "duo", "kid", "kids", "junior", "jr", "max", "total", "cold", "dx", "ds", "o",
]);

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9.%\s]/g, " ")
    .replace(/(?<!\d)\.|\.(?!\d)/g, " ") // keep decimal points, drop other dots
    .replace(/(\d)([a-z%])/g, "$1 $2") // "650mg" -> "650 mg"
    .replace(/\s+/g, " ")
    .trim()
    .replace(PREFIX, "")
    .trim();
}

function numbersIn(s: string): string[] {
  return (s.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => String(parseFloat(n)));
}

/** The query without strength numbers and units, which Fuse matches poorly. */
function nameOnly(q: string): string {
  return q
    .split(" ")
    .filter((t) => !/^\d+(\.\d+)?$/.test(t) && !UNIT_TOKENS.has(t))
    .join(" ")
    .trim();
}

export interface MatchResult {
  candidates: string[]; // SKUs, best first (max 3)
  chosen: string | null; // set when there is one clear match
  inexact: boolean; // names matched, but no product has the strength or variant asked for
}

interface Indexed {
  sku: string;
  brand: string;
  aliases: string[];
  generic: string;
  comp: string[];
  numbers: Set<string>;
  nameTokens: Set<string>;
  active: boolean;
}

const CLEAR_WINNER_GAP = 0.1;

export class Matcher {
  private fuse: Fuse<Indexed>;

  constructor(products: Product[]) {
    const records: Indexed[] = products.map((p) => ({
      sku: p.sku,
      brand: normalize(p.brand),
      aliases: p.aliases.map(normalize),
      generic: normalize(p.generic),
      comp: p.composition.map((c) => normalize(c.name)),
      // Strength numbers: those in the brand ("Dolo 650") plus the first number of each ingredient strength.
      numbers: new Set([
        ...numbersIn(normalize(p.brand)),
        ...p.composition.flatMap((c) => numbersIn(c.strength ?? "").slice(0, 1)),
      ]),
      nameTokens: new Set([p.brand, ...p.aliases].flatMap((n) => normalize(n).split(" "))),
      active: p.active,
    }));
    this.fuse = new Fuse(records, {
      keys: [
        { name: "brand", weight: 3 },
        { name: "aliases", weight: 3 },
        { name: "generic", weight: 1.5 },
        { name: "comp", weight: 1 },
      ],
      includeScore: true,
      ignoreLocation: true,
      threshold: 0.35,
      minMatchCharLength: 2,
    });
  }

  match(query: string): MatchResult {
    const q = normalize(query);
    const name = nameOnly(q);
    if (name.length < 2) return { candidates: [], chosen: null, inexact: false };

    let hits = this.fuse.search(name).map((h) => ({ rec: h.item, score: h.score ?? 1 }));
    // Best score first; on a tie prefer products still on sale.
    hits.sort((a, b) => a.score - b.score || Number(b.rec.active) - Number(a.rec.active));

    const wantedNumbers = numbersIn(q);
    const wantedVariants = name.split(" ").filter((t) => VARIANT_TOKENS.has(t));
    const exact = hits.filter(
      (h) =>
        (wantedNumbers.length === 0 || wantedNumbers.some((n) => h.rec.numbers.has(n))) &&
        wantedVariants.every((v) => h.rec.nameTokens.has(v)),
    );
    const inexact = exact.length === 0 && hits.length > 0;
    if (!inexact) hits = exact;

    const top = hits.slice(0, 3);
    const first = top[0];
    if (!first) return { candidates: [], chosen: null, inexact: false };

    const second = top[1];
    const clear = !second || second.score - first.score > CLEAR_WINNER_GAP;
    return {
      candidates: top.map((h) => h.rec.sku),
      chosen: clear && !inexact ? first.rec.sku : null,
      inexact,
    };
  }
}
