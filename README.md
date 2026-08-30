# 🎤 Karaoke Songbook

A small, fast web app that turns a CSV of `artist,title` pairs into a browsable, searchable songbook. Built for self-hosting on Proxmox (LXC container or Docker VM).

## Features

- **Artist list** — every artist with song counts, virtualised so 10k+ rows scroll smoothly.
- **Side panel** — click an artist to list their songs.
- **Two-pass search** — first shows artists/titles *containing* the typed phrase, then falls back to loose matches where your letters appear in order (marked `≈`). Capped at 100 results.
- **Random button** — picks a random song from the entire collection, regardless of the current search.
- **Favourites** — tap ☆ on any song to save it; the ★ Favourites button shows a manage view where you can remove entries. Stored in the browser's `localStorage` (key `karaoke.favourites.v1`), so each device keeps its own list and nothing is sent to the server.
- **Efficient** — CSV is parsed once at startup into an in-memory index with precomputed normalised strings and character bitmasks; searches are a single linear pass with early rejection. The browser only ever receives the artist list plus ≤100 results.
- **Hot reload** — replace the CSV on disk and the app reloads it within a few seconds, no restart needed.

## CSV format

Two columns, artist and title. A header row is optional — if present, columns are matched by name (`artist`/`band`/`performer` and `title`/`song`/`track`), otherwise column 1 is artist and column 2 is title.

```csv
artist,title
Queen,Bohemian Rhapsody
ABBA,"Gimme! Gimme! Gimme! (A Man After Midnight)"
```

Quoted fields, escaped quotes, commas inside fields, and CRLF line endings are all handled.

## Run locally

```powershell
npm install
npm start
# http://localhost:8080
```

Point at a different file with `CSV_PATH`:

```powershell
$env:CSV_PATH = "D:\karaoke\my-songs.csv"; npm start
```

## Deploy on Proxmox

### Option A — Docker (on a VM or LXC with Docker)

```bash
git clone <your-repo> /opt/karaoke-app && cd /opt/karaoke-app
cp /path/to/your/songs.csv data/songs.csv
docker compose up -d --build
```

The app listens on port 8080. `./data` is mounted read-only at `/data`, so you can drop in an updated CSV and it reloads automatically.

### Option B — plain LXC container (Debian/Ubuntu template)

```bash
apt update && apt install -y nodejs npm git
adduser --system --group --home /opt/karaoke-app karaoke
git clone <your-repo> /opt/karaoke-app
cd /opt/karaoke-app && npm install --omit=dev
cp /path/to/your/songs.csv data/songs.csv
chown -R karaoke:karaoke /opt/karaoke-app

cp deploy/karaoke.service /etc/systemd/system/
systemctl enable --now karaoke
```

Then browse to `http://<container-ip>:8080`. Put it behind nginx/Caddy if you want TLS or a hostname.

## Quiz (host-run, Slido/Kahoot-style)

A live multiple-choice quiz you run from one device while guests answer on their phones.

- Questions live in `data/quiz.json` — an array of `{ question, options: [2-6 strings], correctIndex }`. Edit it and restart the server to load a different set.
- Open `/host.html` on your device to control the quiz: **Start**, **Reveal answer**, **Next question**, **End quiz**, **Reset**. It's protected by a host key — the default is `slp07491514` (override with `QUIZ_HOST_KEY`), and once logged in you can change it from the host page; the new key is saved to `data/.quiz-host-key` and survives restarts.
- Guests open `/quiz.html`, enter a name, and answer from a live-updating page (pushed via Server-Sent Events). There's also a 🧠 Quiz link in the songbook header.
- Scoring: correct answers earn 500–1000 points depending on how fast you answer within the time window; wrong or missed answers score 0.

## Configuration

| Variable         | Default            | Description                             |
| ---------------- | ------------------- | --------------------------------------- |
| `PORT`           | `8080`              | HTTP port                                |
| `HOST`           | `0.0.0.0`           | Bind address                              |
| `CSV_PATH`       | `data/songs.csv`    | Absolute or relative path to song CSV     |
| `QUIZ_PATH`      | `data/quiz.json`    | Absolute or relative path to quiz questions |
| `QUIZ_HOST_KEY`  | `slp07491514`       | Initial shared secret required to control the quiz (changeable from the host page afterward) |
| `QUIZ_ANSWER_MS` | `20000`             | Time allowed per question, in milliseconds |

## API

| Endpoint                        | Returns                                          |
| ------------------------------- | ------------------------------------------------ |
| `GET /api/artists`              | `[{ key, name, count }]` (ETag-cached)           |
| `GET /api/artists/:key/songs`   | `{ artist, songs: [...] }`                       |
| `GET /api/search?q=`            | `{ query, limit, count, results }`, max 100      |
| `GET /api/random`               | A random song from the whole book                |
| `GET /api/stats`                | Song/artist totals and load time                 |
| `GET /api/quiz/state`           | Current public quiz state                        |
| `GET /api/quiz/events`          | SSE stream of quiz state updates                 |
| `POST /api/quiz/join`           | `{ name }` → `{ playerId }`                      |
| `POST /api/quiz/answer`         | `{ playerId, optionIndex }`                      |
| `POST /api/quiz/host/*`         | `start`/`next`/`reveal`/`end`/`reset` — requires `x-quiz-host-key` header |
