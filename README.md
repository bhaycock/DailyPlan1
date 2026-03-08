# Daily Plan

A web app for daily planning with a vertical timeline calendar and Work/Life task lists.

## Features

- **Vertical timeline** — 08:00 to 22:00 in 30-minute slots
- **Work & Life task lists** — up to 6 tasks each, editable, with checkboxes
- **Google Calendar integration** — view, create, move, and delete events
- **Drag tasks to timeline** — drag any task onto a time slot to schedule it
- **Drag events** — reposition calendar events by dragging them to a new slot
- **Click to add** — click any empty slot to create a new event
- **Date navigation** — previous/next buttons and day-of-week quick-jump
- **Tasks sync via Google Tasks** — tasks persist across devices and browsers when signed in; falls back to `localStorage` offline
- **Works offline** — all events/tasks work locally without Google connected

---

## Setup

### 1. Serve the files

You need a local HTTP server (browsers block Google OAuth on `file://`).

```bash
# Python
python3 -m http.server 8080

# Node (npx)
npx serve .

# VS Code
# Install the "Live Server" extension, right-click index.html → Open with Live Server
```

Then open `http://localhost:8080` in your browser.

### 2. Google Calendar & Tasks (optional but recommended)

Without this step the app works fully for local task management and local events. To sync with Google Calendar and persist tasks across devices:

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project (or use an existing one)
3. Navigate to **APIs & Services → Library** and enable both:
   - **Google Calendar API**
   - **Google Tasks API**
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**
5. Application type: **Web application**
6. Add to **Authorised JavaScript origins**: `http://localhost:8080` (or your deployed URL)
7. Copy the **Client ID**
8. Open `app.js` and replace:
   ```js
   const GOOGLE_CLIENT_ID = 'YOUR_CLIENT_ID.apps.googleusercontent.com';
   ```
   with your actual Client ID.

Then reload the page and click **Connect Calendar**.

---

## Usage

| Action | How |
|---|---|
| Navigate days | `<` / `>` buttons, or click a weekday letter |
| Add an event | Click any empty time slot |
| Schedule a task | Drag the `⋮⋮` handle from a task onto the timeline |
| Move an event | Drag the event card to a new slot |
| Edit / delete | Click an event card |
| Complete a task | Tick the circle checkbox |

---

## File structure

```
index.html   — Page structure
style.css    — All visual styling
app.js       — Application logic (tasks, events, Google API)
```

## Deploying

Any static file host works: GitHub Pages, Netlify, Vercel, Cloudflare Pages.
Remember to add your deployed URL to the OAuth client's authorised origins.
