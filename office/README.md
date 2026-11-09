# Private office

Cloudflare-hostable office for one operator. The browser UI and the bot feed are the same origin, and both require a credential the Worker checks itself. A public ntfy topic behind a private page is not this design.

This repository does not contain a feed topic, an ingest token, or an Access secret. Deploy is manual. This change does not publish the Worker, change DNS, or edit the public homepage in `landing/`.

## What you run

One Worker (`grokbot-private-office`) with:

- Workers static assets for the existing 3D office (`office/assemble.mjs` copies `web/` and `assets/` into `office/public/`, which is not committed).
- One SQLite Durable Object class, `Office`. That is the request log and the ask table. Free-plan Workers include SQLite Durable Objects. No KV, D1, R2, or paid plan is required.
- No custom domain in `wrangler.jsonc`, so a deploy does not create a DNS record. `workers.dev` is on so you can attach Access to that hostname. Turn `workers_dev` off only after some other hostname is protected.

Cloudflare Access, in front of that hostname:

- An Allow policy for your email. Access is free for a small number of users.
- A service token for the bots. The Worker compares `CF-Access-Client-Id` and `CF-Access-Client-Secret` to the secrets you set. It does not trust `Cf-Access-Authenticated-User-Email`.
- The browser JWT (`Cf-Access-Jwt-Assertion`) is verified against the team JWKS. `aud` must be `ACCESS_AUD` and `iss` must be `https://<ACCESS_TEAM_DOMAIN>`.

## Settings

Set these with `npx wrangler secret put` from `office/` after `npx wrangler login`. Do not put the values in git, in the prompt, or in the dashboard page.

| Name | Required | Purpose |
|---|---|---|
| `ACCESS_TEAM_DOMAIN` | yes, for Access | Team host, such as `your-team.cloudflareaccess.com`. Not a secret, but keep it in a secret or var rather than this repo. |
| `ACCESS_AUD` | yes, for Access | Access application audience tag (AUD). |
| `ACCESS_SERVICE_CLIENT_ID` | for bots via Access | Service token client id. |
| `ACCESS_SERVICE_CLIENT_SECRET` | for bots via Access | Service token secret. |
| `INGEST_TOKEN` | alternative to the service token | Bearer token for `POST /api/ingest`. At least 16 characters. Must differ from `USER_TOKEN`. |
| `SESSION_SECRET` | if you use the harness login | HMAC key for the `__Host-office` cookie. At least 16 characters. |
| `USER_TOKEN` | leave unset in production | Break-glass bearer for a human. The login form exists only when `ALLOW_BEARER_LOGIN` is `1`. |
| `ALLOW_BEARER_LOGIN` | production: unset or `0` | Wrangler var, not a secret. `1` shows an empty password form for the test harness. |

`USER_TOKEN` and `INGEST_TOKEN` are rejected if they are the same string.

## Ingest contract

`POST /api/ingest` with `Authorization: Bearer <INGEST_TOKEN>` or both Access service-token headers. One JSON object, at most 4 KB. Same-origin browser calls are allowed; there is no `Access-Control-Allow-Origin: *`.

Activity (unchanged, still updates the 3D office):

```json
{"bot":"Health Bot","status":"working","step":"evening workout"}
```

`working`, `idle`, and `done` do not resolve anything. A legacy `waiting_user` line opens one ask whose id is `legacy:<bot id>:<hash of the step>`. Repeating the same step dedupes. A different step is a different ask. The row stays open when a newer status arrives, and the UI marks it **Needs explicit ack**. That is a migration, not a resolution.

Explicit ask:

```json
{"type":"request","id":"weekly-review","bot":"Health Bot","action":"open","detail":"weekly review","source":{"kind":"routine","name":"weekly review","ref":"week-45","at":"2026-11-09T15:00:00Z"}}
```

Resolve that id only:

```json
{"type":"request","id":"weekly-review","action":"resolve"}
```

Or, while signed in, `POST /api/requests/<id>/resolve`. An unknown id resolves nothing else.

Roster, looks, groups, chat, routines, usage, and needle lines are still accepted. A needle line is a replaceable strip, not an ask. Unread chat is not read; if a bot should surface a chat message, it has to post a `request` for that one message.

The human session cannot ingest. The ingest credential cannot read `/api/state`.

## Rollout

The public GitHub Pages office and the old ntfy topic stay world-readable until you stop using them. Shipping this branch does not make that feed private.

1. Read this file and set the Access application and secrets yourself. Do not commit them.
2. `node office/assemble.mjs` then, from `office/`, `npx wrangler deploy`.
3. Put Access in front of the workers.dev hostname (and any later hostname). Confirm a signed-out browser gets the sign-in wall for `/office/` and `401` for `/office/api/state` and `/office/app.js`.
4. Open the office signed in. The top bar says Private and offers Sign out. Sign out clears the office cookie and sends the browser to `/cdn-cgi/access/logout`.
5. Give the bots the ingest URL and the service token out of band. Replace the shared memory rule that posts to the public topic. Do not paste the token into `PROMPT.md` or the public site.
6. Post one explicit request, then a newer `working` line. The bot in the office shows the new activity. Waiting on me still shows the request.
7. For old `waiting_user` lines, acknowledge each row, or post `action":"resolve"` for that legacy id. They are not auto-resolved.
8. Stop every bot from posting to the old topic. The topic is anonymous read/write. Anyone who already has the link can still read and write it until you abandon it. ntfy.sh drops messages after about 12 hours; copies can remain in browser site data on machines that opened the public office. Clear that site data. Do not describe the office as private while anything still posts to that topic.

## Backout

1. Point bots back at the previous feed only if you accept that the public topic is in use again.
2. Remove the Access application or disable the Worker (`npx wrangler delete` from `office/`). Deleting the Worker does not by itself promise the Durable Object storage is gone the same minute; delete the `Office` object from the Cloudflare dashboard if you need the stored asks removed.
3. Revert this branch to restore the public page's older Waiting list, which follows the latest status.
4. Nothing in this backout erases lines already sent to the old public topic.

## Local checks

`node --test office/test/office.test.mjs web/lib/requests.test.mjs`

Codex CLI was not used. `command -v codex` prints nothing on this machine, and there is no `codex` binary on `PATH`.
