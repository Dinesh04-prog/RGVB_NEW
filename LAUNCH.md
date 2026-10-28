# Kirana POS — going live

Everything in the code is done. These are the steps only you can do (they need your accounts). All of them are free
except the Google Play developer fee ($25, once). Do them in this order.

---

## 1. Firebase: allow sign-in (5 minutes)

The app signs in with Google and hands the token to Firebase. The Google sign-in button belongs to a different Google Cloud
project than Firebase, so Firebase must be told to accept it.

1. Open <https://console.firebase.google.com> → project **nexus-pos-817c3** → **Build → Authentication → Get started**.
2. **Sign-in method → Google → Enable**, pick a support email, **Save**.
3. Open Google again: **Sign-in method → Google** → expand **Web SDK configuration / Allowlist client IDs from external
   projects** → add `786802419853-8m6fpah9na9ecdhfc8fo8d55e3b5r728.apps.googleusercontent.com` → **Save**.
4. **Settings → Authorized domains**: make sure `localhost` is there (for testing on the computer).

## 2. Switch the shop over (one evening, all phones together)

The new app keeps every shop's data separately (`shops/…`). The old app on the shop's phones reads the old shared lists,
so switch everything at the same time:

1. **Publish the security rules** (computer, in `nexus-react-pos`):
   ```
   firebase login
   firebase deploy --only firestore:rules
   ```
   (Or Firebase console → Firestore → Rules → paste `nexus-react-pos/firestore.rules` → Publish.)
2. Build the new APK: GitHub → **Actions → Build Kirana POS Android app → Run workflow** (branch `feature/multi-shop`, or
   `main` after merging). Download **KiranaPOS-N** from the run's Artifacts.
3. **Owner phone:** install, sign in → **Create my shop** → fill in the details → ☰ **Shop & Cashiers** → **Import old
   inventory** (once). Then **✏️ Edit**: tagline, bill number start (e.g. `AA` to keep the old style), UPI ID, logo.
4. **Add the cashiers:** Shop & Cashiers → **Add a cashier** → their Gmail. Install the APK on their phones; they sign in
   and go straight to billing. Bills already on their phones are uploaded to the cloud by themselves.
5. After a week, in `firestore.rules` delete the block under *Old single-shop data* and publish the rules again.

## 3. Privacy policy and account-deletion pages (free, 5 minutes)

Google Play needs both as web pages.

1. Put your contact email in `nexus-react-pos/site/privacy.html` and `site/delete-account.html` (replace
   `[your contact email]`).
2. Publish: in `nexus-react-pos` run `firebase deploy --only hosting`.
3. Your pages:
   - Privacy policy: `https://nexus-pos-817c3.web.app/privacy.html`
   - Account deletion: `https://nexus-pos-817c3.web.app/delete-account.html`

## 4. Photo reading (Gemini) — optional, free tier

Already deployed? Then redeploy once so it checks sign-in and counts scans per person:
```
cd gemini-worker
npx wrangler deploy
```
`wrangler.toml` now has `USER_DAILY_CAP = "20"` (scans per person per day) and `REQUIRE_SIGN_IN = "false"`. When every
phone runs the new app, change it to `"true"` and deploy again: then a copied app key alone no longer works.

## 5. Release signing key (once, keep it forever)

Google Play only accepts apps signed with your own key. **If you lose this key you can never update the app.**

1. Make the key (Java's keytool; any computer with Java):
   ```
   keytool -genkeypair -v -keystore kirana-release.jks -alias kirana -keyalg RSA -keysize 2048 -validity 10000
   ```
   Choose a password and remember it. Keep `kirana-release.jks` **and** the password in two safe places (e.g. Google Drive
   + a pen drive). Never commit it to Git.
2. Turn it into text for GitHub (PowerShell):
   ```
   [Convert]::ToBase64String([IO.File]::ReadAllBytes("kirana-release.jks")) | Set-Clipboard
   ```
3. GitHub → repo → **Settings → Secrets and variables → Actions → New repository secret**, add:
   - `KEYSTORE_BASE64` — paste from the clipboard
   - `KEYSTORE_PASSWORD` — the keystore password
   - `KEY_ALIAS` — `kirana`
   - `KEY_PASSWORD` — the key password (same as the keystore password if you pressed Enter)
4. Run the workflow again. The run now gives two files: **KiranaPOS-N** (APK, for phones) and **KiranaPOS-N-play-bundle**
   (`app-release.aab`, for Google Play).

## 6. Google Play

1. Create a developer account: <https://play.google.com/console/signup> ($25 once). Personal accounts must run a
   **closed test with at least 12 testers for 14 days** before going public — start inviting shopkeepers early.
2. **Create app**: name *Kirana POS*, app, free.
3. **Set up your app** (the dashboard checklist):
   - Privacy policy URL → the page from step 3.
   - App access → "All or some functionality is restricted": explain sign-in with Google and give reviewers a Gmail you
     added as a cashier to a demo shop (Shop & Cashiers → Add a cashier).
   - Ads → No ads.
   - Content rating → questionnaire (business / utility app, no user-to-user content).
   - Target audience → 18+.
   - Data safety → collected: name, email, phone numbers (customers'), photos (item pictures, pack photos for reading),
     app activity (bills); encrypted in transit; users can request deletion; deletion URL from step 3. Not shared,
     no ads.
   - Account deletion → the URL from step 3.
4. **Store listing**: short description (80 characters), full description, the icon
   `nexus-android/play-store-icon-512.png`, a feature graphic (1024 × 500) and at least 4 phone screenshots.
5. **Testing → Closed testing** → create a track → upload `app-release.aab` → add testers' emails → share the opt-in link.
6. After 14 days with 12+ testers: **apply for production**, then roll out (start with 20%, then 100%).

Each new upload needs a higher version number — the GitHub build does that by itself (it uses the run number).

---

### What it costs while the shops are few

Nothing, except the $25 Play fee. Firebase stays in its free daily limits (the app downloads only changed items, not the
whole list), Firebase Hosting is free, the Cloudflare Worker and the Gemini free tier are free. If you later move Firebase
to the Blaze plan, set a budget alert (e.g. ₹100) first.
