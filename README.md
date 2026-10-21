# Pharmacy bot (POC)

A Telegram bot for an Indian pharmacy. A customer sends a prescription photo, a PDF or a typed list. The bot finds the medicines, sells only the ones that don't need a prescription, holds the stock, collects the address and takes a demo payment.

> POC only. The catalogue is sample data, payments are fake, and prescription-only medicines are always refused. See "Before real customers" below.

## Run it

1. **Get a bot token:** message [@BotFather](https://t.me/BotFather) on Telegram, send `/newbot`, and copy the token.
2. **Get a Gemini key:** create a free API key in [Google AI Studio](https://aistudio.google.com/). This is optional: without it, typed lists still work but photos and PDFs don't.
3. **Find your chat ID:** message [@userinfobot](https://t.me/userinfobot). Put the ID in `ADMIN_CHAT_IDS` to get order alerts and admin commands.
4. **Install and start:**

```bash
cp .env.example .env
```

Fill in `.env`, then:

```bash
npm install
```

```bash
npm start
```

The bot uses long polling, so it runs from your laptop with no server, domain or webhook. Stop it with Ctrl+C.

## Try these messages

| Send | What happens |
|---|---|
| `2 strips dolo 650, crocin` | Both found, cart with a "contains paracetamol" warning, full checkout |
| `paracetamol 500` | Asks you to pick Crocin Advance or Calpol 500 |
| `augmentin 625, limcee` | Augmentin refused (Schedule H), Limcee sold |
| `taxim o` | Refused (Schedule H1), no order created |
| `otrivin` | Out of stock, with a "tell me when it's back" button |
| `hexidine` | Out of stock: the only batch expires within 90 days |
| `8 strips shelcal` | Capped at 4 (per-order limit) |
| `dulcolax` | Swapped for Dulcoflex (discontinued) |
| `pan-d` | Not guessed as Pan 40 (different formulation) |
| A prescription photo or PDF | Read by Gemini, then the same flow |

Typing `yes` or `no` works in place of most buttons. Payment always needs a tap.

## How it works

```
Telegram ──► channels/telegram.ts ──► core/engine.ts (conversation state machine)
                                         ├─ core/parse.ts     typed lists, quantities
                                         ├─ extract/gemini.ts photos, PDFs, unclear text → JSON
                                         ├─ core/matcher.ts   fuzzy match against the catalogue
                                         ├─ core/rules.ts     schedule rules, per-order limits, replacements
                                         ├─ core/inventory.ts FEFO stock, holds, expiry
                                         ├─ core/orders.ts    order IDs, pricing
                                         └─ core/payment.ts   mock UPI (swap for Razorpay/Cashfree later)
```

- **Gemini is called only when needed:** for photos, PDFs, and typed text the local matcher can't place.
- **Gemini only extracts.** Whether something can be sold is decided by code from `catalogue.json`, so a prescription or message can't talk the bot into selling something.
- **The customer always confirms the list** before anything is checked.
- **Stock is held for 15 minutes** once the cart is shown, then released if checkout isn't finished. Paid orders take stock from the earliest-expiring batch first (FEFO) and record which batches went out.
- **Each customer's messages are handled one at a time.** All data writes go through one lock, and lowdb writes files atomically.

The engine has no Telegram code in it. A WhatsApp adapter only needs to turn WhatsApp webhooks into `InboundMessage`s and render `OutboundMessage`s.

## Data (`data/`)

| File | Who writes it | Notes |
|---|---|---|
| `catalogue.json` | You | 47 sample Indian medicines with MRP, schedule, limits and aliases. Edits reload automatically while the bot runs |
| `inventory.json` | Bot and admin commands | Batches with expiry. Stop the bot before editing it by hand, or use `/addstock` |
| `orders.json`, `reservations.json`, `customers.json`, `sessions.json`, `waitlist.json` | Bot | Runtime state |
| `audit.jsonl` | Bot | One line per event: extraction results, refusals, orders |
| `uploads/` | Bot | Prescription files. Deleted after `UPLOAD_RETENTION_DAYS` |

Runtime files hold personal and health data and are git-ignored.

**Sale rules** live in `catalogue.json` → `meta.schedule_rules`:
- OTC items are sold automatically.
- G, H and H1 items are refused (later: pharmacist review).
- Schedule X items are never sold online.

## Admin commands

These work only from chats listed in `ADMIN_CHAT_IDS`:

```
/stock dolo                                  stock, batches, near-expiry flags
/lowstock                                    items at or below reorder level
/addstock OTRIVIN-OXY-10ML 20 OTX6J001 2028-09   add a batch; tells waiting customers
/orders                                      last 10 orders
/reload                                      reload catalogue.json now
```

## Development

```bash
npm test
```

```bash
npm run typecheck
```

The tests run the whole conversation against a temporary copy of `data/`, with a fake extractor and clock. They don't touch your real data or Telegram.

## Before real customers

- **Licensing:** you need a retail drug licence (Form 20/21) and a registered pharmacist. India still has no final e-pharmacy rules.
- **Check the catalogue:** a pharmacist should check every schedule and MRP in it against the pack labels. Entries with `verified.schedule: false` need this most.
- **Move off Gemini's free tier:** free-tier inputs can be used by Google and seen by human reviewers. Use a paid tier for real prescriptions.
- **Real payments:** replace `MockPaymentProvider` with a UPI provider (payment link plus webhook confirmation).
- **Pharmacist review:** add a queue for Schedule H items with valid prescriptions.
