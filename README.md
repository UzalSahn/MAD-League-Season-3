# MAD League

The site uses two deployments:

- **GitHub Pages** hosts the static HTML, CSS, images, and browser code.
- **A Node.js API host** handles PIN sign-in and league updates, and keeps the SQLite database on persistent storage.

GitHub Pages cannot run the API or store the database. Players use the Pages address; the website sends API requests to the Node service.

## Try It Locally

Install Node.js 20 or newer. In PowerShell, from this repository folder, install the API dependency and set the first commissioner account before starting the server:

```powershell
npm install
$env:COMMISSIONER_NAME = "League Commissioner"
$env:COMMISSIONER_PIN = "482915"
npm start
```

Choose a private 4-12 digit PIN rather than reusing the example. Open `http://localhost:3000`. The first commissioner can create player accounts from the Commissioner page. By default the SQLite database is saved at `../mad-league-data/league.sqlite`.

Run the integration tests with `npm test`.

## Publish The Website

1. Push the repository to GitHub on the `main` branch.
2. In the repository, open **Settings > Pages** and select **GitHub Actions** as the build and deployment source.
3. The workflow in `.github/workflows/pages.yml` publishes the HTML pages, browser API client, configuration, and logos. It deliberately does not publish the Node server or database.
4. Note the Pages address shown by GitHub. A project site usually looks like `https://ACCOUNT.github.io/REPOSITORY/`; its origin for CORS is only `https://ACCOUNT.github.io`.

## Host The API

Create a Node.js web service on a host that supports a persistent disk. For example, on a host such as Render, create a web service from this repository with Node.js 20+, build command `npm install`, and start command `npm start`. Attach persistent storage to the service; the storage feature may require a paid plan.

Set these environment variables in the hosting dashboard:

- `COMMISSIONER_NAME`: the initial commissioner’s name.
- `COMMISSIONER_PIN`: a private 4-12 digit PIN; enter it as a secret and don’t commit it.
- `NODE_ENV`: `production`.
- `DATA_DIR`: the persistent disk’s mount path, for example `/var/data`.
- `ALLOWED_ORIGINS`: the Pages origin, for example `https://ACCOUNT.github.io` (no repository path and no trailing slash).

The host supplies `PORT`. Run one API instance with its persistent disk. The initial database is created on first start and contains only the commissioner account. Existing data from the previous hosted system is not imported.

After the API service is running, copy its HTTPS base address from the host, then set `API_BASE_URL` in `site-config.js` to that address, without a trailing slash. Commit and push that change; GitHub Actions republishes the Pages site. Players can then sign in through the Pages address and share league updates through the API.

Player PINs are stored as salted hashes. The browser keeps the login token for the current tab; if the server restarts, players may need to sign in again. Back up the SQLite file on the persistent disk regularly. PIN access is intended for a designated, trusted group rather than high-security use.