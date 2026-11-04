# Verify browser page isolation

Use a separate local instance and workspace. The probe deliberately attempts a project creation named
`isolation-bypass`; never install it on a production workspace. No external requests or agent calls are needed.

1. Choose a private `HARNESS_PILOT_LOCAL_DIR` and a free `HARNESS_PILOT_PORT` (8801–8809).
2. Copy `server/tests/fixtures/isolation-check` into that instance's `workspace/extensions/isolation-check`.
3. Build the web app (`cd web && npm ci && npm run build`), then start `bash scripts/dev-local.sh` with those
   two environment variables. Complete the normal setup in the browser.
4. Open `/x/isolation-check`. All eight checks must say Passed: direct API read and write, parent DOM and app
   storage are blocked, encoded traversal through the bridge is rejected, own-service reads/writes work, and
   the attempted bypass creates no project. Own-service writes persist only under the extension's state folder.
5. Click Test internal navigation: the host URL becomes `/x/isolation-check/verified` without losing the page.
6. Test an API 1 page: it keeps compatibility until the owner selects Isolate this page. Returning to compatibility
   must show a confirmation explaining full session authority. Check the proposed mode in the Studio too.

The unit suite separately sends `Origin: null` with a valid cookie and CSRF header and expects HTTP 403 without
changing settings. It covers asset-token binding, permission revocation, disabled pages, symlink escapes,
unsupported methods, wrong senders and stale channels. Happy DOM tests simulate messages, not browser sandbox
enforcement; the real-browser probe is required for that evidence.

This validates browser isolation. Trusted compatibility pages and in-process Python handlers still retain their
existing authority. Safari behavior and stage B's separate process/user isolation need independent validation.
