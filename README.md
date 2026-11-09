# Grok Bot Wallpaper

Live wallpaper and dashboard for your Grok Bot bots (an independent project, not affiliated with the makers of Grok Bot): a 3D office where every bot is a glossy blob at a desk on the top floor of an endless tower,
and you see in real time who is working, who is stuck and who is waiting for you. No AI at runtime: bots append one
line per step to a journal, a tiny Node server tails it, the browser renders the office.

Work in progress.

## Your own bots (no server)

You do not need to run anything to see your own bots. They post their status to a channel on [ntfy](https://ntfy.sh) (or on an ntfy server you run). The dashboard reads that one server. It does not contact any other host with the topic.

### How it works

Each bot runs one `curl` on its own box whenever its status changes and sends a short JSON line to `https://ntfy.sh/<topic>`. The dashboard and the wallpaper are static pages: your browser reads that channel straight from the feed server (the last 12 hours, then live) and draws the office. There is no server and no tunnel in this mode, and nothing connects in to the bots' box: they only make outbound HTTPS calls.

### Setup

1. Copy the block from `PROMPT.md` and paste it into your Grok Bot once. It makes the topic (`gbw-` plus 22 random letters and digits), saves the posting rule in the shared memory of all your bots, posts the roster and a look for each bot, and sets up the daily and 2-hourly routines.
2. The bot replies with a path, `office/#<topic>`. Open that path on the site where you host this dashboard.
3. For the wallpaper, open `face/#<topic>` on the same site. Lively (Windows, `lively/README.md`) and the Mac app (`mac/README.md`) take that page's full address.

### The line formats

One JSON object per POST, at most 4 KB.

```json
{"bot":"X Writer","group":"X content","status":"working","step":"drafting a post"}
{"roster":["X Writer","Trends"]}
{"looks":{"X Writer":{"shape":"rounded_cube","color":"#2D84F5","accessory":"none"}}}
{"type":"usage","total_used_pct":37,"resets_at":"2026-11-01T18:00:00+02:00","bots":{"X Writer":4.1}}
{"chat":{"X Writer":"grokbot://app/v1/agent?id=<bot id>"}}
{"routines":{"bot":"X Writer","items":[{"name":"Morning thread","schedule":"daily 09:00","next_run":"2026-11-02T09:00:00+02:00"}]}}
{"type":"needle","updated_at":"2026-11-06T17:31:15Z","footer":{"label":"Full list: bot dashboard","url":"https://yash-bot-dashboard.pages.dev"},"items":[{"id":"…","kind":"bbb","label":"decide-later","bot":"BBB Bot","title":"…","need":"…","date":"2026-11-05","chat_url":"grokbot://app/v1/agent?id=…"}]}
```

- **status**, posted on every status change of any bot. `bot` is the exact name, `status` is one of `working`, `idle`, `waiting_user`, `error`, `done`, `step` is what the bot does, at most 80 characters. `group` (optional) is the bot's team: each team gets its own floor of the office.
- **needle**: at most 5 filtered backlog items (`kind` is `bbb` or `content`, label `decide-later`) for the Waiting on me strip, under any live tap-now cards, including when those cards are empty. Each next message replaces the whole strip. It never creates a bot. Open chat opens the owning bot. Approve copies `approve needle <id>: <title>` and opens that chat. Skip copies `skip needle <id>: <title>` and hides the row until the next needle post. Optional `footer` links to the full list.
- **roster**: the exact names of all your bots, so quiet bots show up too. Re-posted every morning.
- **looks**: one look per bot. `shape` is one of `sphere`, `rounded_cube`, `pill`, `triangle`, `cone`, `pentagon`, `hexagon`, `star4`, `star6`, `clover`, `rounded_square`, `trio`. `accessory` is one of `none`, `glasses`, `stem`, `antenna`, `bow`. `color` is `#RRGGBB`. Details in `docs/AVATARS.md`. Re-posted every morning.
- **usage**: total used in percent, when it resets, and per bot. Fields the bot does not know are left out. Posted every 2 hours.

### Privacy

- The topic is the password. Anyone who has it can read your bots' statuses and post fake ones, so do not share the links. Keep the topic after the `#`. The browser does not send the fragment to the site that hosts the dashboard. An older wallpaper link puts it in `?feed=`, and that query is sent to the host, so prefer the fragment.
- ntfy is not encrypted end to end: the ntfy server can read every line. Keep secrets and personal data out of `step`.
- ntfy.sh keeps messages for 12 hours. The dashboard caches the last state in your browser, so it still shows your bots after that; clear the site data to remove it.
- To change the topic, ask your bot to make a new one and run the setup again.
- The page does not send the topic, the token, or the feed to any host other than the feed server named in the link.

### Limits

The free ntfy.sh tier allows 250 messages a day per IP address. Every status change is one message, so about 50 or more bots (or a few very busy ones) need a paid ntfy plan or your own ntfy server.

For your own server, put it in the fragment, not the query string:

`#<topic>&ntfy=https://your.server`

A protected topic also takes the ntfy access token there. The token is sent only to that server, as ntfy's `auth` query value (base64 of `Bearer <token>`), because the live stream cannot set an Authorization header:

`#<topic>&ntfy=https://your.server&auth=<token>`

`http://` is accepted only for `localhost`, `127.0.0.1`, and `::1`. Tell the bots to post to that server instead of `https://ntfy.sh`. The server needs to be reachable from both the bots' box and your browser, and it must allow the page's origin to read the topic (ntfy's CORS headers do this).

`relay/` is an optional mailbox you can run yourself. The dashboard does not call it unless `&ntfy=` names it.

### Troubleshooting

```sh
curl "https://ntfy.sh/<topic>/json?poll=1&since=1h"
```

1. No lines: the bots have not posted, or post to another topic. Ask a bot to post a test status line and compare its topic, letter by letter, with the one in your link.
2. Lines appear but the dashboard is empty: the link has another topic, or the lines are not valid JSON (they are skipped). Open the link from the bot's reply again.
3. An error about a limit: the daily message limit is reached, see Limits.

## Run

```sh
./start.sh            # Node 24, no dependencies; prints the URL and a generated password on first start
./stop.sh
```

Each bot appends a line to `data/events.jsonl` (format: `docs/CONTRACT.md`, section 1):

```json
{"t":"2026-11-01T12:00:00+02:00","bot":"X Writer","group":"X-контент","status":"working","step":"пишу драфт поста","task":"Тред про AI-агентов"}
```

As a desktop wallpaper (Lively, Windows): `docs/WALLPAPER.md`; the Grok Bot wallpaper in one click: `lively/README.md`. Server details: `README-server.md`. Your own logo on the tower: `assets/brand/logo.png` (white on transparent).

## Private office

`office/README.md` is a separate Cloudflare Worker. It signs in both the page and the feed, and it keeps asks until an explicit resolve. The public ntfy topic is unchanged until you stop posting to it. Do not treat this Pages site as private while that topic is still in use.

## Credits

- Earth imagery: NASA Earth Observatory (Blue Marble, Black Marble), public domain.
- Furniture models used in the office build: Kenney Furniture Kit, CC0.
