# MAD League

The site supports two backends:

- **Firebase Hosting, Cloud Firestore, and Cloud Functions** for a hosted league. Players sign in with a commissioner-assigned name and PIN; they do not need Google accounts.
- **The local Node.js server and SQLite** for local development.

## Host on Firebase

Firebase Hosting serves the static pages. Firestore stores the league and account records, while callable Cloud Functions verify PINs, issue Firebase sign-in tokens, and enforce commissioner-only operations. Firestore rules let signed-in, enabled league accounts read the league but deny direct client writes. PINs are stored as salted hashes and are never readable by the browser.

**Important billing note:** Firebase Hosting and Firestore have no-cost allowances, but deploying Cloud Functions requires the Firebase project to use the Blaze plan with a billing account linked. A small league may stay within no-cost usage allowances, but Blaze is pay-as-you-go and usage can incur charges. Review current [Firebase pricing](https://firebase.google.com/pricing) and set a Google Cloud budget alert before deployment.

1. Create or select a Firebase project. Register a Web App and copy its Firebase web configuration.
2. In the Firebase console, enable **Authentication** and create a **Cloud Firestore** database. Players will not use Google sign-in; Authentication is used for the site's custom name/PIN sign-in.
3. Install the Firebase CLI, sign in, and associate this repository with the project:

   ```powershell
   npm install --global firebase-tools
   firebase login
   firebase use --add
   ```

4. Set the initial commissioner's name and 4-12 digit PIN as Functions secrets. These are only used to initialize the commissioner account on the first successful sign-in:

   ```powershell
   firebase functions:secrets:set COMMISSIONER_NAME
   firebase functions:secrets:set COMMISSIONER_PIN
   ```

   Do not commit these values. The commissioner can create the other player accounts and assign their PINs from the Commissioner page.

5. Edit `site-config.js`: set `BACKEND` to `'firebase'` and replace the placeholder values in `FIREBASE_CONFIG` with the Web App configuration from the Firebase console. The web configuration is public; do not put PINs or service-account credentials there.
6. Deploy the Firestore rules, callable functions, and website:

   ```powershell
   firebase deploy --only firestore:rules,functions,hosting
   ```

   Functions use Node.js 22. The first deployment initializes no league records; the commissioner account and empty league are created on the commissioner's first successful sign-in.

To go back to local development, set `BACKEND` to `'local'` in `site-config.js`, then run the local server below. Keep the Firebase project configuration in the file if you intend to deploy the Firebase version again.

## Run Locally

Install Node.js 20 or newer. In PowerShell, from this repository folder:

```powershell
npm install
$env:COMMISSIONER_NAME = "League Commissioner"
$env:COMMISSIONER_PIN = "482915"
npm start
```

Choose a private 4-12 digit PIN rather than reusing the example. Open `http://localhost:3000`. The first commissioner can create player accounts from the Commissioner page. By default the SQLite database is saved at `../mad-league-data/league.sqlite`.

Run the integration tests with `npm test`.

## Alternative: GitHub Pages with the Node API

The existing GitHub Pages workflow remains available for the static site. GitHub Pages cannot run the API or store the database, so this option also needs a Node.js API host with persistent storage.

1. Push the repository to GitHub on the `main` branch. In repository **Settings > Pages**, select **GitHub Actions** as the build and deployment source.
2. Create a Node.js web service on a host that supports persistent storage. For example, use Node.js 20+, build command `npm install`, start command `npm start`, and attach a persistent disk for the SQLite database.
3. Set `COMMISSIONER_NAME`, `COMMISSIONER_PIN`, `NODE_ENV=production`, `DATA_DIR` (the persistent disk mount path), and `ALLOWED_ORIGINS` (the Pages origin, such as `https://ACCOUNT.github.io`) in the host dashboard.
4. Set `API_BASE_URL` in `site-config.js` to the API's HTTPS base URL, without a trailing slash, and leave `BACKEND` as `'local'`. Commit and push; GitHub Actions republishes the Pages site.

Back up the SQLite file regularly. The first run creates an empty league with only the commissioner; existing hosted data is not imported.
