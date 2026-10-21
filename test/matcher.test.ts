import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { normalizeIndianMobile } from "../src/core/engine.ts";
import { Matcher } from "../src/core/matcher.ts";
import { parseTypedList } from "../src/core/parse.ts";

const matcher = new Matcher(JSON.parse(readFileSync("data/catalogue.json", "utf8")).products);

test("matches brands, misspellings and prescription shorthand", () => {
  for (const [q, sku] of [
    ["dolo", "DOLO650-15"],
    ["Tab. Dolo-650mg", "DOLO650-15"],
    ["dollo", "DOLO650-15"],
    ["crosin", "CROCINADV500-20"],
    ["Syp. Ascoril LS", "ASCORILLS-100ML"],
    ["jhandu balm", "ZANDU-BALM-10ML"],
    ["isabgol", "SATISABGOL-100G"],
    ["ors", "ELECTRAL-SACHET"],
  ] as const) {
    assert.equal(matcher.match(q).chosen, sku, q);
  }
});

test("does not guess when strength or variant differs", () => {
  const panD = matcher.match("pan-d");
  assert.equal(panD.chosen, null);
  assert.equal(panD.inexact, true);
  assert.equal(matcher.match("dolo 500").chosen, null);
  assert.equal(matcher.match("telma h").chosen, null);
  assert.deepEqual(matcher.match("xyzabc").candidates, []);
});

test("parses quantities from typed lists", () => {
  assert.deepEqual(
    parseTypedList("2 strips dolo 650, crocin x3 and eno\nplease send me 1 pan 40\nmujhe vicks chahiye").map((i) => [i.name, i.quantity]),
    [
      ["dolo 650", 2],
      ["crocin", 3],
      ["eno", 1],
      ["pan 40", 1],
      ["vicks", 1],
    ],
  );
});

test("normalises Indian mobile numbers", () => {
  assert.equal(normalizeIndianMobile("98765 43210"), "+919876543210");
  assert.equal(normalizeIndianMobile("+91-98765-43210"), "+919876543210");
  assert.equal(normalizeIndianMobile("09876543210"), "+919876543210");
  assert.equal(normalizeIndianMobile("12345"), null);
  assert.equal(normalizeIndianMobile("5876543210"), null);
});
