# DawaDesk

Pharmacy ordering on Telegram and WhatsApp, with a staff dashboard. Built for a pharmacy in India.

**Customers** chat with the bot. They send a prescription photo, a PDF or a typed list. The bot:
- finds the medicines,
- sells only those that don't need a prescription,
- holds the stock while they check out,
- checks the delivery distance and the opening hours,
- and takes payment by UPI (Razorpay) or cash on delivery.

Questions the bot shouldn't answer go to the pharmacist.

**Staff** use the dashboard to:
- see orders live and assign delivery agents,
- answer customer questions and take over chats,
- manage stock and batches,
- set opening hours, delivery radius and fees,
- manage staff and their permissions,
- and watch the numbers.

> The catalogue in `data/` is sample data. A registered pharmacist must check every schedule and price before real sales. See [Before real customers](#before-real-customers).

## Who can do what

| Role | Default access |
|---|---|
| **Admin** | Everything, including staff accounts, roles and the activity log |
| **Manager** | Orders, agents, refunds, stock, customers, inbox, questions, settings, opening hours |
| **Pharmacist** | Questions and prescription reviews, inbox, stock and interaction rules, orders (view only) |
| **Delivery agent** | Only their own deliveries, on a phone-friendly page |

Admins can create more roles, change what any role can do, and give or remove single permissions for one person (**Staff & roles**).

## Run it on your computer

You need Node 22 or newer. No database to install: development uses an embedded PostgreSQL (PGlite), stored in `data/pgdata`.

```bash
npm install
```

```bash
npm --prefix dashboard install
```

```bash
cp .env.example .env
```

In `.env`, set `TELEGRAM_BOT_TOKEN` (from @BotFather) and, if you want prescription photos read, `GEMINI_API_KEY`. Leave `DATABASE_URL` empty.

Build the dashboard and create your admin account:

```bash
npm run build
```

```bash
npm run user:create -- --role admin --name "Your Name" --email you@example.com
```

That prints a password. Then start everything:

```bash
npm start
```

Open http://localhost:3000 and log in. The bot is on Telegram, using long polling.

To work on the dashboard with instant reload, run `npm run dev:dashboard` in a second terminal and open http://localhost:5173.

## How it works

```
Telegram ─┐                                 ┌─ Gemini: reads photos, PDFs, unclear text
WhatsApp ─┼─► Engine (src/core/engine.ts) ──┼─ Matcher, sale rules, interaction checks
          │     conversation + orders       ├─ Stock: FEFO batches, 15-minute holds
Razorpay ─┘                                 └─ Razorpay payment links and refunds
                       │
                       ▼
                  PostgreSQL ◄──── API (Fastify, /api) ◄──── Dashboard (React, served at /)
                       │                    │
                       └── live events ─────┘  (new orders, messages, questions; with sound)
```

- **The AI only reads.** Gemini extracts names and quantities. Whether something can be sold, its price and its stock come from the database and fixed rules, so a message or prescription can't talk the bot into selling a prescription medicine.
- **Fixed sale rules:**
  - OTC medicines are sold.
  - Schedule G, H and H1 are refused, and the customer can send the prescription to the pharmacist.
  - Schedule X is never sold online.
- **Stock:**
  - Batches expiring within the near-expiry window (90 days by default) aren't sold.
  - Paid orders take the earliest-expiring batch first and record which batch went out.
  - Carts hold stock for 15 minutes.
- **Hours:** orders placed while the shop is closed, or after the same-day cut-off, are scheduled for the next opening. Staff can open or close the shop from the top bar.
- **Delivery radius:** the customer shares their location and the bot checks the distance from the pharmacy. The delivery time shown depends on the distance.
- **Pharmacist questions:**
  - Symptom questions, complaints and prescription reviews appear in **Questions**, with a sound alert.
  - The answer goes back to the customer's chat.
  - Questions left unanswered too long alert the managers.
- **Staff takeover:** in **Inbox**, staff can take over a chat. The bot stays quiet until they hand it back.

Everything about the pharmacy is set in the dashboard under **Settings**: name, phones, location, weekly hours, holidays, cut-off, radius, fees, delivery-time bands, payment methods and timers. `.env` holds only server settings and secrets.

## Deploy on Oracle Cloud with aaPanel

These steps assume an Ubuntu VM with aaPanel installed and a domain (say `admin.yourpharmacy.in`) pointing at the VM.

### 1. Open the firewall

- **Oracle Cloud:** go to **Networking → Virtual cloud networks → your VCN → Security lists**. Add ingress rules for TCP 80 and 443 from `0.0.0.0/0`.
- **The VM itself:** Oracle's Ubuntu images block ports with iptables. Open 80 and 443 in aaPanel's **Security** page, or with `iptables` plus `netfilter-persistent save`.
- **Keep port 3000 closed** to the internet. Only Nginx talks to it.

### 2. Install Node and PostgreSQL

- **Node 22 or newer:** install from aaPanel's **Website → Node project**, or with nvm.
- **PostgreSQL:** install it from the aaPanel **App Store** (PostgreSQL Manager) or with `apt install postgresql`. Create a database and a user. From the command line:

```bash
sudo -u postgres psql -c "CREATE USER dawadesk WITH PASSWORD 'choose-a-strong-password';"
```

```bash
sudo -u postgres psql -c "CREATE DATABASE dawadesk OWNER dawadesk;"
```

### 3. Get the code and configure it

```bash
git clone <your repo URL> /www/wwwroot/dawadesk && cd /www/wwwroot/dawadesk
```

```bash
npm ci && npm --prefix dashboard ci && npm run build
```

```bash
cp .env.example .env
```

In `.env`, set:
- `DATABASE_URL=postgres://dawadesk:PASSWORD@127.0.0.1:5432/dawadesk`
- `PUBLIC_URL=https://admin.yourpharmacy.in`
- `TELEGRAM_MODE=webhook`, plus a random `TELEGRAM_WEBHOOK_SECRET`
- your Gemini key
- the Razorpay and WhatsApp settings (steps 6 and 7)

Then create the first admin:

```bash
npm run user:create -- --role admin --name "Your Name" --email you@example.com
```

Tables are created automatically on first start, and the sample catalogue is loaded if the database is empty.

### 4. Run it with PM2

```bash
npm install -g pm2
```

```bash
pm2 start ecosystem.config.cjs && pm2 save && pm2 startup
```

`pm2 startup` prints a command; run it once so DawaDesk comes back after a reboot. Logs are in `logs/` and in `pm2 logs dawadesk`. (aaPanel's PM2 Manager can show the same process.)

### 5. Nginx and HTTPS (aaPanel)

1. **Add the site:** **Website → Add site** for `admin.yourpharmacy.in`.
2. **Get a certificate:** under **SSL**, request a Let's Encrypt certificate and turn on **Force HTTPS**.
3. **Proxy to DawaDesk:** under **Config**, replace the `location /` block with the one below. Live updates need buffering off and a long timeout.

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_read_timeout 1h;
    client_max_body_size 25m;
}
```

When the server starts in webhook mode it registers the Telegram webhook itself.

### 6. Razorpay

1. **Start in test mode.** In the Razorpay Dashboard, use the **test mode** keys (`rzp_test_...`) first.
2. **Add the keys:** set `PAYMENT_PROVIDER=razorpay`, `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET`.
3. **Add the webhook:** **Account & Settings → Webhooks → Add**. The URL is `https://admin.yourpharmacy.in/webhooks/razorpay`. Choose a secret and put it in `RAZORPAY_WEBHOOK_SECRET`. Enable these events:
   - `payment_link.paid`
   - `payment_link.expired`
   - `payment_link.cancelled`
   - `refund.processed`
4. **Restart:** `pm2 restart dawadesk`. Place a test order, pay with Razorpay's test UPI, and check that the order turns **Paid**.
5. **Go live:** switch to live keys only after KYC is approved and the whole flow has been tested.

Refunds start automatically when staff cancel a paid order. Normal refunds take 5–7 working days to reach the customer.

### 7. WhatsApp (production channel)

1. **Set up the app:** in Meta for Developers, create an app with WhatsApp, add your business phone number and complete business verification.
2. **Add the credentials:** put the permanent access token, phone number ID and app secret in `.env`, and choose a `WHATSAPP_VERIFY_TOKEN`.
3. **Set the webhook:** **WhatsApp → Configuration → Webhook**. The callback URL is `https://admin.yourpharmacy.in/webhooks/whatsapp` and the verify token is the same one. Subscribe to **messages**.
4. **Approve a follow-up template.** WhatsApp only allows free-form replies within 24 hours of the customer's last message. Get a utility template approved with two variables, for example *"Message from {{1}}: {{2}}"*, and enter its name in **Settings → WhatsApp**. Staff replies after 24 hours go out as that template.

Telegram and WhatsApp can run at the same time; each customer is tied to the channel they used.

### 8. Backups

Back up the database every night and keep copies off the server, for example in Oracle Object Storage:

```bash
pg_dump -h 127.0.0.1 -U dawadesk -Fc -d dawadesk -f /backups/dawadesk_$(date +%F).dump
```

Also back up `data/uploads`, where prescription files are kept until the retention period ends. Restore with:

```bash
pg_restore -h 127.0.0.1 -U dawadesk -d dawadesk --clean --if-exists /backups/dawadesk_2026-10-26.dump
```

### Updating

```bash
git pull && npm ci && npm --prefix dashboard ci && npm run build && pm2 restart dawadesk
```

Database changes ship as migrations in `drizzle/` and run on start. Staff with the dashboard open pick up the new version on their next click.

## Development

```bash
npm test
```

```bash
npm run typecheck
```

- **Tests:** they run the bot, the API and the WhatsApp adapter against an in-memory PostgreSQL, with fake channels, payments and clock.
- **Schema changes:** after changing `src/db/schema.ts`, run `npm run db:generate` to create a migration.

Layout:

```
src/core/       bot conversation, matching, rules, intents, interactions
src/services/   orders, stock, customers, settings, hours, distance
src/api/        dashboard API, login and permissions, webhooks
src/channels/   Telegram and WhatsApp adapters
src/payments/   Razorpay and the mock provider
src/db/         schema, migrations runner, seed
dashboard/      React dashboard (Vite, Tailwind)
```

## Before real customers

- **Licence:** a retail drug licence (Form 20/21) and a registered pharmacist. India has no final e-pharmacy rules yet.
- **Catalogue:** a pharmacist checks every schedule and MRP in **Inventory**. The "not verified" badges show which ones were estimated.
- **Interaction rules:** your pharmacist adds them in **Interaction rules**. The bot already warns about the same ingredient twice.
- **Gemini:** use a paid tier for real prescriptions. Free-tier data may be used by Google.
- **Privacy:** the bot asks for consent and deletes uploaded prescriptions after the retention period (Settings). Keep backups encrypted and access limited.
