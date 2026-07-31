# Why authentication looks like this

Four questions that come up every time someone reads the setup steps. The short answers are in the
[README](../README.md); this is the reasoning behind them, so nobody has to re-derive it.

Verified against Google's documentation on 2026-08-01. Google moves this UI and these policies
around — if something below no longer matches what you see, the [sources](#sources) are at the end.

---

## Why the client type is called "TVs and Limited Input devices"

Because it is the only client type for which Google enables the **Device Authorization Grant**
(RFC 8628) — the "here is a code, type it on another device" flow. A `Desktop app` or
`Web application` client makes the `device/code` endpoint answer `invalid_client`.

Read "TV" as "device where typing is awkward and there is nowhere to redirect to", and Obsidian on a
phone is exactly that. The alternatives were all dead ends:

| Approach                            | Why not                                                                                                       |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Loopback redirect (`127.0.0.1`)     | Needs a local HTTP server. Impossible on iOS and Android.                                                     |
| Out-of-band (`oob`)                 | Google shut it down in October 2022.                                                                          |
| Custom scheme (`obsidian://`)       | Google only accepts custom schemes on Android/iOS client types, which means two more clients and app signing. |
| Loopback via a `Desktop app` client | Google restricts that client type to `http://localhost` / `127.0.0.1` redirects — same server problem.        |

The device flow does not accept every scope; it has an allowlist. `drive.file` is on it, alongside
`drive.appdata`, `email`, `openid`, `profile` and a few YouTube scopes. That is load-bearing: had
`drive.file` been absent, the whole flow would have been unusable and the PKCE fallback would have
become the only path.

`src/drive/pkce-flow.ts` exists for the case where the device flow is refused anyway. It redirects
to a `127.0.0.1` URL that nothing serves, and asks the user to paste the address bar back — ugly,
but it needs no server, so it also works on a phone.

---

## Why you create your own OAuth client instead of the plugin shipping one

This is a real trade-off, not an oversight. Both designs work.

**What GeodeDrive does:** you create an OAuth client and paste the id and secret into settings. Ten
minutes, once.

**The alternative:** the developer creates one client and embeds the id and secret in the plugin.
Users press Connect and never see the Cloud Console. rclone and several Obsidian plugins do this.

`drive.file` being a **non-sensitive** scope is what makes the embedded approach viable at all — no
100-user cap, no verification submission, no security assessment. So the choice is genuinely open.
What it costs:

- **The secret stops being secret.** Anyone can read it out of `main.js`. Google accepts this for
  installed apps, where the client secret is explicitly not treated as confidential — but it does
  let someone impersonate the app on a consent screen.
- **Everyone shares one API quota.** Invisible at ten users, something to watch at a thousand.
- **One point of failure.** If that Cloud project gets blocked or runs out of quota, every user's
  backup breaks at the same moment.

That last one decided it. For a _backup_ tool, people discover the breakage precisely when they need
the backup. Ten minutes of setup buys independence from someone else's Google project staying alive.

If this is ever revisited, the shape to build is the hybrid: a built-in client by default, with
"use my own OAuth client" behind an advanced toggle. `readClient()` in `src/main.ts` is already the
single place that would need a fallback.

---

## Why not just a Google login and password

There is no API to call. Google retired ClientLogin — the username/password API — in **2015**. No
endpoint accepts an email and a password and returns a Drive token.

Even if one existed, it would break on any account with two-factor authentication, and a third-party
window asking for a Google password is indistinguishable from phishing. Obsidian's plugin review
rejects it and Google blocks it.

OAuth is the replacement, and the consent screen living in the browser — not in the plugin — is the
entire point: GeodeDrive never sees your password.

---

## Why the app has to be published

Google issues every **External** app whose publishing status is **Testing** a refresh token that
expires after **7 days**. For a backup tool that means failing with "Google revoked this connection"
once a week, forever.

**Audience → Publish app** removes the limit permanently. Because `drive.file` is non-sensitive,
publishing needs no review submission and no security assessment.

Publishing does not list the app anywhere. There is no catalogue, no marketplace entry and no way to
discover an OAuth client — Workspace Marketplace is a separate, opt-in submission. "In production"
changes exactly one thing: the Test users allowlist stops applying, so anyone holding your client id
**and** secret could authorize the app.

And if someone did, they would be granting access to **their own** Drive, not yours — a token
belongs to the account that approved it. The actual exposure from a leaked secret is your project's
quota and your app's name on someone else's consent screen. Both are fixed by rotating the secret or
deleting the client.

Two consequences for this repository:

- `data.json` holds the client secret and the refresh token, so it is in `.gitignore`.
- `.obsidian/` is never backed up — enumeration goes through `app.vault.getFiles()`, which excludes
  it — so the secret never reaches Drive either.

A published token still lapses if you revoke it at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions), or after six months
with no push or pull.

---

## Summary

| Question                    | Answer                                                                       |
| --------------------------- | ---------------------------------------------------------------------------- |
| Why that odd client type?   | Only one Google enables the device flow for.                                 |
| Why the device flow?        | The only flow needing no local server, so it works on a phone.               |
| Why your own OAuth client?  | Your backup does not depend on someone else's Cloud project surviving.       |
| Why not login and password? | No such API since 2015, and it would be a phishing pattern if there were.    |
| Why publish?                | Testing status expires the refresh token every 7 days.                       |
| Does publishing expose me?  | No. Nothing is listed anywhere, and a leaked secret cannot reach your files. |

---

## Sources

- [OAuth 2.0 for TV and Limited-Input Device Applications](https://developers.google.com/identity/protocols/oauth2/limited-input-device)
  — required client type, and the scope allowlist that includes `drive.file`
- [Using OAuth 2.0 to Access Google APIs](https://developers.google.com/identity/protocols/oauth2)
  — the 7-day refresh token under Testing status
- [Drive API-specific authorization and authentication](https://developers.google.com/drive/api/guides/api-specific-auth)
  — `drive.file` classified as non-sensitive
- [Manage app audience](https://support.google.com/cloud/answer/15549945) — where Test users and
  Publish app live in the current console

This document is kept in English only. Unlike the README, it is aimed at contributors, and a stale
translation of a security rationale is worse than no translation.
