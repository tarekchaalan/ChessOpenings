# ADR 0009 — Sign in with Lichess / Chess.com, and verified linked accounts

- **Status:** built on branch `claude/oauth-login` (2026-10-20). Lichess works today; Chess.com is wired and waits for the credentials Chess.com issues after approving its OAuth application form.
- **Requested by the owner:** "wire up the functionality and login buttons… you can implement lichess today, but need to wait to hear back from chess.com to wire theirs up." Reference: Lichess's API demo app (OAuth2 PKCE login).
- **Migration:** `0010_oauth_identities.sql`, tested with `scripts/supabase/test-0010.sh` and the account-deletion test; the owner applies it to the hosted project.

## Context

- `linked_accounts.verified` (0006) has existed since Insights, always false: a linked username is typed, so anyone can claim any public name. The friends feature labels imported data "unverified" because of this.
- Lichess OAuth needs no app registration: any `client_id`, Authorization Code + PKCE (S256), and an empty scope gives read access to `/api/account` (identity only).
- Chess.com runs OAuth 2.0 + OpenID Connect, but only for approved apps. You apply with a form, and approved apps get client credentials. PKCE is required for public clients. Identity comes in a signed ID token. Its endpoint URLs and claim names aren't public, so they're configuration here.
- Supabase Auth has no Lichess or Chess.com provider.

## Decisions

1. **Our own OAuth routes, then a Supabase session.** `GET /api/auth/oauth/[provider]` starts the flow: PKCE verifier and state go into an httpOnly, SameSite=Lax cookie scoped to `/api/auth/oauth`, 10-minute lifetime. `…/callback` checks the state, exchanges the code and reads the identity. For sign-in it creates a session with `auth.admin.generateLink({ type: "magiclink" })`, which sends no email, then `verifyOtp({ token_hash })` on the request cookies (the same server-side verification `/auth/callback` already uses). Both routes sit under `/api/` so the proxy's `?code=` rescue for email links leaves them alone.
2. **Identities are their own table** (`oauth_identities`). The key is (provider, provider's stable user id), plus a unique (user_id, provider). So one Lichess account signs in to exactly one app account, and an account has at most one identity per provider. Unlinking an Insights account (which deletes its games) doesn't remove a way to sign in. Own-row select under RLS; writes only through the routes, with the service role.
3. **First sign-in creates an account.** It gets a placeholder email, `lichess.<id>@oauth.invalid` (RFC 2606 reserved, nothing is ever sent there), and the provider's name becomes the requested username (`-` → `_`, cut to 20 characters; the sign-up trigger adds a suffix if the name is taken). The platform is linked and verified with the ratings Lichess returns, so the first-login setup modal opens prefilled. The address is derived from the provider id, so a retried or concurrent first sign-in finds the same user (`generateLink` returns it) instead of making a second one. Settings hides the email and password cards for these accounts, because `double_confirm_changes` would need the old address to confirm a change.
4. **No auto-merge by email.** Lichess sign-in never attaches itself to an existing email account. To add Lichess sign-in to an email account, a signed-in player uses **Connect** (Settings → Sign-in methods) or **Verify with Lichess** (the linked-accounts panel).
5. **Linking rules** (`linkIdentity`):
   - An identity held by another account is refused (`oauth_taken`).
   - A Lichess name that differs from the username already linked is refused (`oauth_mismatch`), because replacing it would silently delete that account's games.
   - Otherwise the identity replaces the player's previous one for that provider, and the linked account is verified, or created if there's none.
   - Signing in verifies a linked account with the same name, but never re-links one the player unlinked.
   - Typing the username of your own identity in the link form keeps it verified.
6. **No tokens are kept.** The Lichess token is revoked (`DELETE /api/token`) as soon as `/api/account` is read. Chess.com's ID token is read once. Its signature isn't checked, because it came straight from the token endpoint over TLS in exchange for our code and verifier (OIDC Core § 3.1.3.7). Audience, expiry and the optional issuer are checked.
7. **Insights accounts are connected only by signing in** (owner's follow-up, 2026-10-20: "when they connect their accounts for insights, they login with chess.com/lichess only, this links their account, and makes sure they're verified"). For a platform with OAuth configured (always Lichess; Chess.com once its credentials are set):
   - The linked-accounts panel and the setup modal show **Connect Lichess**, with no username field. For a guest, the button is **Continue with Lichess**: it signs them in (or creates the account), and that links and verifies Lichess.
   - The server enforces it. `POST /api/insights/link` answers 403 `proof_required` for a name that isn't the player's own OAuth identity. Re-linking the name already linked still refreshes its ratings.
   - The browser imports a connected account's games on the first load after the redirect (`importConnected`). A re-run setup modal reopens after the round trip.
   - Older typed links stay, marked "not verified", with **Verify with Lichess**. Nothing is deleted.
   - "Save guest insights to your account" skips OAuth platforms: those are connected by signing in, and their games import again.
   - Until Chess.com is approved, Chess.com keeps the typed, unverified username (owner's choice). It switches to Connect as soon as `NEXT_PUBLIC_CHESSCOM_CLIENT_ID` and the endpoints are set.
8. **Configuration.**
   - Lichess needs nothing. `LICHESS_CLIENT_ID` defaults to the site's host, which is what the Lichess consent screen shows. `LICHESS_HOST` is for testing against a local lila.
   - Chess.com buttons appear when `NEXT_PUBLIC_CHESSCOM_CLIENT_ID` is set. The server also needs `CHESSCOM_AUTHORIZE_URL` and `CHESSCOM_TOKEN_URL`, and optionally `CHESSCOM_CLIENT_SECRET`, `CHESSCOM_SCOPE` (default `openid profile`) and `CHESSCOM_ISSUER`.
   - Redirect URI to register with Chess.com: `https://chessopenings.tarekchaalan.com/api/auth/oauth/chesscom/callback`.

## When Chess.com approves

Set the variables above from what they send. Then check two assumptions in `chesscomIdentity` (`src/lib/server/oauth.ts`) against their docs:
- which claim carries the username (`preferred_username`, then `username`, are tried);
- whether the client secret goes in the body (`client_secret_post`, as here) or in a Basic header.

## Not built

- Disconnecting a sign-in method.
- Adding a real email to an account created through Lichess.
- Lichess gameplay or board API (the demo app's other half).
- Server-side imports with the token: tokens are deliberately not kept.

## Known limits

- Supabase rate-limits token verifications per IP. Sign-ins verify from the server, as email links already do, so very heavy sign-in traffic from one serverless IP could hit the limit.
