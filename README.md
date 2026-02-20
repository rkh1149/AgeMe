# AgeMe

AgeMe is a GitHub Pages frontend plus a Cloudflare Worker backend that edits a portrait to make the subject look older or younger with configurable parameters.

## Frontend (GitHub Pages)

Files:
- `web/index.html`
- `web/styles.css`
- `web/app.js`

Deploy the `web/` folder to GitHub Pages.

## Backend (Cloudflare Worker)

Files:
- `worker/src/index.ts`
- `worker/wrangler.toml`

### Worker setup

1. Install Wrangler and log in:
   - `npm install -g wrangler`
   - `wrangler login`
2. Go to worker directory:
   - `cd worker`
3. Set OpenAI key:
   - `wrangler secret put OPENAI_API_KEY`
4. Deploy:
   - `wrangler deploy`

The worker exposes:
- `GET /api/capabilities`
- `POST /api/age-face`
- `OPTIONS` (CORS preflight)

Set the frontend API Endpoint field to your deployed worker URL, for example:
- `https://ageme-worker.<your-subdomain>.workers.dev/api/age-face`

### Capability probe endpoint

You can inspect current backend/upstream constraints with:

- `GET /api/capabilities` (no upstream call, no model cost)
- `GET /api/capabilities?probe=1` (runs a live OpenAI compatibility probe; may incur image API cost)

Example:

- `https://ageme-worker.<your-subdomain>.workers.dev/api/capabilities`
- `https://ageme-worker.<your-subdomain>.workers.dev/api/capabilities?probe=1`

## Request schema

Multipart form data:
- `image` (file, image/*, max 8MB)
- `params` (JSON string)

`params` shape:

```json
{
  "age_delta": 15,
  "intensity": 0.6,
  "hair_color": "preserve",
  "glasses": "preserve",
  "baldness": 0,
  "blemish_fix": 30,
  "skin_texture": 20,
  "quality": "medium",
  "preserve_identity": true
}
```

## Notes

- API keys are never exposed in client code.
- The worker includes server-side validation for all parameters.
- CORS defaults to `*` in `wrangler.toml`; restrict it for production.
