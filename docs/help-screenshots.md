# Help guide media: how to re-capture the screenshots

Guides are markdown files in `frontend/src/app/help/content/`. A guide may start with front matter:

```
---
video: https://www.youtube.com/watch?v=abc123   # YouTube, Vimeo, Loom, Cloudflare Stream, or a direct https .mp4
video_title: Setting up rooms
images:
  - file: getting-started/02-rooms-and-rates/1-room-types.webp   # under frontend/public/help/images/
    alt: The Room Types tab with one type listed
    caption: Setup → Room Types
---
```

The video loads nothing from its host until the reader presses play. Do not commit video files: host them and link them. Every help image must be a `.webp` of 300 KB or less (a test fails otherwise).

## Re-running the capture

1. Use a throwaway local database (not the shared one if it is behind on migrations):
   `docker exec lodgekeep-mysql-1 mysql -uroot -p… -e "create database lodgekeep_dev_help; grant all on lodgekeep_dev_help.* to 'lodgekeep'@'%'"`
   then `cd backend && DB_NAME=lodgekeep_dev_help npx knex migrate:latest`.
2. Seed the fictional demo hotel ("Palm Grove Demo Hotel", slug `demo-help`):
   `cd backend && DB_NAME=lodgekeep_dev_help EMAIL_PROVIDER=console node scripts/seed-help-demo.js` (add `--reset` to rebuild).
   It refuses unless NODE_ENV is not production, DB_NAME is `lodgekeep_dev` or `lodgekeep_dev_<suffix>`, the DB host is local, no real app domain or email provider is configured and no live Paystack key is present.
3. Start the app against that database: `DB_NAME=lodgekeep_dev_help EMAIL_PROVIDER=console node src/server.js` in `backend/`, and `npx vite --port 5173` in `frontend/`.
4. `cd frontend && npx playwright install chromium` once (an installed Google Chrome is used if that is skipped), then `npm run help:capture` (add `--guide=getting-started/05-pos` for one guide).
5. The script writes `frontend/public/help/images/<guide>/<name>.webp` (fixed 1280x800 viewport, light theme, no browser chrome, the target highlighted in red) and prints the `images:` front matter to paste into the guide if it changed.

What to capture is listed in `frontend/scripts/help-capture/manifest.json`: per guide, each screenshot's `name`, `alt`, `caption`, the `steps` to click (by role and accessible name) and the element to `highlight`. The script only visits `*.localhost` addresses.
