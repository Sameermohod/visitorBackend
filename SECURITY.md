# Security

What protects the backend, website and phone app, and what you must set when you go live.

## Before going live (do these)

1. **Set strong secrets.** `JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET` and `ENCRYPTION_KEY` must each be a random string of 32+ characters. Make one with
   `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
   In production the server refuses to start if a JWT secret is missing. Changing a JWT secret signs everyone out. Never change `ENCRYPTION_KEY` once society payment keys are stored.
2. **Set `CORS_ORIGIN`** to your web app address (comma-separated for several). Only those websites can call the API from a browser. Phone apps are not affected.
3. **Change the demo passwords.** The seed creates `admin@`, `resident@`, `guard@saassociety.com` (password `welcome123`) and `superadmin@saassociety.com` (`superadmin123`). Change or delete them in any real database.
4. Keep `ALLOW_DEMO_PAYMENTS=false`.
5. Serve everything over https.

## What is in place

| Area | Protection |
|---|---|
| Sign-in | 20 tries per 15 minutes per address (successful sign-ins do not count); an account locks for 15 minutes after 6 wrong passwords; unknown email and wrong password answer alike and take the same time |
| Passwords | At least 8 characters with a letter and a number, no well-known passwords. Stored with bcrypt. Applies to sign-up, password change and passwords an admin sets for residents, staff and tenants |
| Sessions | Access token 15 minutes. Refresh token rotates on every use and only its SHA-256 fingerprint is stored. Changing your password ends all other sessions. Signing out ends the session on the server (web and phone) |
| Token types | A connection (MCP) token only works on `/mcp`. Camera viewing tokens use a separate key. A refresh token cannot be used as a login token. Sockets refuse these too |
| Browser access | CORS allow-list (`CORS_ORIGIN`, `FRONTEND_URL`; localhost allowed only outside production) |
| Requests | 1 MB body limit, society headers must be well-formed, broken JSON returns 400, general rate limit |
| Responses | Strict security headers (no framing, no sniffing, no referrer, HSTS), `no-store` on all API answers, internal error text hidden in production, API docs hidden in production (`ENABLE_API_DOCS=true` to show) |
| Data | Every query is scoped to the society; society and user are checked on each request. Raw SQL only uses parameters. Stripe and camera links are encrypted (AES-256-GCM) |
| Website | Content-Security-Policy on the built site (own scripts only), idle sign-out after 30 minutes, no offline demo login and no demo buttons in production builds, printed posters escape their text |
| Phone app | Tokens in the system keystore, backups off, sign-out also ends the server session |

## Known limits

- Lock-out and rate-limit counters are kept in memory. With more than one server copy, move them to Redis.
- The website keeps its login in browser storage (like most single-page apps). The CSP and idle sign-out reduce the risk; httpOnly cookies would reduce it further but need a larger change.
- One refresh token is stored per person, so signing in on a second device signs the first one out.
- Not yet built: two-factor sign-in, an audit log of admin actions, and email alerts for new-device sign-ins.
- Remaining dependency warnings (run `npm audit`): `zod` 3.x (memory use on huge arrays; the 1 MB limit contains it) and build-tool packages used only during development.
