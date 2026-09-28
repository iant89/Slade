# Slade — GitHub OAuth relay

A ~100-line Cloudflare Worker that lets Slade's **device flow** sign-in work from
a static page.

## Why this exists

GitHub's device flow needs two HTTP calls:

| Call | Endpoint |
| --- | --- |
| Ask for a code | `POST https://github.com/login/device/code` |
| Poll for the token | `POST https://github.com/login/oauth/access_token` |

Neither endpoint sends `Access-Control-Allow-Origin`, so a browser page cannot
call them (this is deliberate on GitHub's side — see
[community discussion #40077](https://github.com/orgs/community/discussions/40077)).
Everything *else* Slade does — repos, trees, files, gists, issues — goes to
`api.github.com`, which **is** CORS-enabled.

So the flow is: browser → your relay → github.com. The relay is a dumb
pass-through; it holds no secret (device flow has none), accepts only the four
parameters the flow defines, and logs nothing.

## Deploy

```bash
cd workers/github-oauth-relay
npx wrangler deploy
```

Then in Slade: **Settings → GitHub → Sign-in relay** → paste the printed
`https://slade-github-oauth.<you>.workers.dev` URL.

No client ID lives here — Slade asks for that in Settings, so this worker can be
shared or re-deployed without touching the app.

## Running Slade locally?

You do not need this worker: `npm run dev` and `npm run preview` serve the same
two endpoints from Vite middleware (see `scripts/github-oauth-relay.ts`), so a
fresh checkout can sign in without deploying anything.

## Alternatives

Any small service that forwards those two POSTs and returns GitHub's JSON works —
Deno Deploy, a Vercel/Netlify function, an nginx `proxy_pass`. If you would
rather not run one at all, Slade still offers the paste-a-token path in the same
connect card.
