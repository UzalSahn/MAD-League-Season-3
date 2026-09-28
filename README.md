# MAD League

The site runs as a single Node.js application. It serves the existing HTML pages, stores one league in SQLite, and handles designated-player name/PIN sessions.

## Run locally

Use Node.js 20 or newer and run `npm install`. On the first run, configure the initial commissioner in the shell; do not put the PIN in the repository. Replace the example with a private 4-12 digit PIN:

```powershell
$env:COMMISSIONER_NAME = "League Commissioner"
$env:COMMISSIONER_PIN = "482915"
npm start
```

Open `http://localhost:3000`. The first commissioner can create each player account from the Commissioner page. Player PINs are hashed before storage. The league and accounts are saved to `../mad-league-data/league.sqlite` by default.

Run the HTTP integration tests with `npm test`.

## Hosting

Deploy the repository to a Node.js host, not static-only hosting. Configure `COMMISSIONER_NAME` and `COMMISSIONER_PIN` before the first start, set `NODE_ENV=production`, and attach a persistent disk. Set `DATA_DIR` to that disk's mount path and `PORT` to the port supplied by the host. Run a single server instance with that disk. Keep the app and browser on the same HTTPS origin so the HTTP-only session cookie is sent correctly.

The initial database is intentionally empty apart from the commissioner account. Existing hosted league data is not imported. PIN access is intended for a designated, trusted group; page-level role checks are not a substitute for a high-assurance authorization system.