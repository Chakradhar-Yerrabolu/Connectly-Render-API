# Connectly API — Render deployment package

This package contains the Connectly Fastify API, Prisma schema/migrations, and the minimal pnpm workspace needed to build it. The Next.js frontend is deployed separately (for example, on Vercel).

## Important: Render does not deploy a ZIP directly

Extract this ZIP, put the `Connectly-Render-API` folder in a GitHub repository, and connect that repository to Render. Alternatively, copy these files into your existing Connectly repository and push the changes. Do not upload the ZIP as an application artifact in the Render dashboard.

## Render setup

1. Create a new **Blueprint** in Render and connect the GitHub repository containing `render.yaml`, or create a Web Service from the repository.
2. If creating a Web Service manually, use the repository root as the Root Directory.
3. Runtime: Node.
4. Build command:

   ```bash
   corepack enable && corepack prepare pnpm@10.12.1 --activate && pnpm install --no-frozen-lockfile && pnpm --filter @connectly/server prisma:generate && pnpm --filter @connectly/server build
   ```

5. Start command:

   ```bash
   pnpm --filter @connectly/server prisma:deploy && pnpm --filter @connectly/server start
   ```

6. Set Health Check Path to `/health`.
7. Use the Free instance plan for the initial portfolio deployment.

## Required environment variables

Set these in Render's Environment page. Never commit real values.

| Variable | Value |
|---|---|
| `DATABASE_URL` | Neon PostgreSQL connection string, including `?sslmode=require` if required by Neon |
| `JWT_ACCESS_SECRET` | Long random secret; Render Blueprint generates one automatically |
| `WEB_ORIGIN` | Exact deployed frontend origin, e.g. `https://your-app.vercel.app` |
| `ADMIN_USERNAME` | Your chosen admin username |
| `ADMIN_PASSWORD` | A new strong production-only admin password; do not use the local temporary password |
| `LIVEKIT_URL` | LiveKit Cloud WebSocket URL |
| `LIVEKIT_API_KEY` | LiveKit API key |
| `LIVEKIT_API_SECRET` | LiveKit API secret |
| `BREVO_API_KEY` | Brevo transactional API key (optional if email is disabled) |
| `EMAIL_FROM` | Sender address verified in Brevo (optional if email is disabled) |
| `EMAIL_FROM_NAME` | `Connectly` |
| `APP_BASE_URL` | Exact deployed frontend origin |

Render provides `PORT` automatically. Do not hardcode it. `NODE_ENV` is set to `production` in `render.yaml`.

## Database migrations

The start command runs `prisma migrate deploy` before starting the API. Use a fresh production Neon database, and take a backup before deploying schema changes to an existing database. Do not use `prisma migrate dev` in production.

## UptimeRobot

After deployment, create an HTTPS monitor for:

`https://YOUR-RENDER-SERVICE.onrender.com/health`

A five-minute monitor can reduce idle sleeping, but cannot guarantee uptime or prevent maintenance/restarts. It is monitoring/keep-warm behavior, not an uptime SLA.

## Important free-tier limitations and current media storage

- Render Free services can sleep and have resource/usage limits.
- This API currently writes uploaded media to `UPLOAD_DIR` (default `./uploads`). Render Free has an ephemeral filesystem. Uploaded files can disappear after restart, redeploy, or instance replacement.
- Therefore this API package is deployable for API/auth/chat/admin/call signalling tests, but **do not treat media uploads and evidence storage as production-persistent yet**. Before relying on profile images, chat attachments, voice files, or report evidence in a public deployment, integrate a persistent object-storage provider and test access controls.
- LiveKit Cloud credentials are required for real audio/video calls. Verify TURN/TLS connectivity from mobile networks.
- Free hosting can have cold starts, quotas, and interruptions. UptimeRobot does not remove those limitations.

## Test after deploy

1. Open `https://YOUR-RENDER-SERVICE.onrender.com/health`; expect JSON with `status: "ok"`.
2. Confirm Render logs show successful Prisma migrations and API startup.
3. Configure the frontend's `NEXT_PUBLIC_API_URL` to the Render API origin, then redeploy the frontend.
4. Set `WEB_ORIGIN` to the exact Vercel production URL.
5. Test registration/login, two-user messaging, blocking/reporting, admin moderation, and LiveKit calls.
6. Do not publish production admin credentials or API secrets.
