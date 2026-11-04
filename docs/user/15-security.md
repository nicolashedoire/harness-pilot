---
section: Reference
---
# Security

harness-pilot gives its web interface access to the connected agent tools and, when configured, to Telegram. The verified local setup runs under the operating-system user who starts it, on `127.0.0.1:8787`. A newly initialized local workspace uses Claude's `default` permission mode; an existing configuration retains its own settings. Codex sessions use the CLI sandbox: read-only in default and plan modes, workspace-write for the other modes. Shell jobs run with the permissions of the application user.

**Local installation** below describes the verified local setup, checked against the code. The sections after it describe a Linux server installation (see [Installation](installation)) and do not apply to the local Mac setup (Sign-in and Files apply to both). The server installation has been verified in Debian 12 and Ubuntu 24.04 containers, where the firewall and SSH settings are left to the host: its hardening has not yet been verified on a real server. Check the actual permissions configured for your installation.

## Privacy defaults

The app explicitly disables native FastAPI request tracing, metrics, telemetry logs and automatic
OTLP exporter setup, including when the parent environment enables automatic OpenTelemetry.
The original project's registration/heartbeat service remains off by default, including for a
restored legacy opt-in configuration, and its registration, feedback and license settings are not
reachable: those requests answer "not found" and send nothing. This does not remove your local conversation history,
operational logs or token statistics; they remain useful application data on your machine.

App-launched Codex turns, resumes and connection-status checks disable built-in analytics and OTLP log, metric and trace
exporters, and do not opt into exporting raw prompts or answers. These are per-process settings;
your personal Codex configuration is not rewritten. Claude Code's existing quiet-start default
disables its nonessential traffic; an explicitly supplied environment or saved override remains
an explicit operator choice. Trusted external agent plugins manage their own telemetry settings.

Using a cloud agent still sends its working prompt/context to that agent's service, and configured
integrations such as Telegram still contact their service. Disabling product telemetry does not
turn a cloud model into an offline model. Codex's exporter options are documented in the
[official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Local installation

This is the setup started with `scripts/dev-local.sh`. It protects the interface from other people and from other
websites; it does **not** protect your computer from the agents you start: they run as your user account.

### Who can reach the interface

- The server listens on `127.0.0.1:8787` only (`pilot serve --host 127.0.0.1`, config `bind`): other devices on
  your network cannot connect. `pilot init --bind` refuses a public address such as `0.0.0.0`, and `pilot doctor`
  fails when the port listens on one.
- Every program and every account of this computer can open that address, so the interface still has a password
  (see **Sign-in** below). The first one is set through a one-time link (`pilot setup-link`, valid one hour). Wrong
  passwords are throttled, and every change request needs the `X-Maxxing: 1` header, which another website open in
  your browser cannot send.
- A website cannot reach the server under its own name either (DNS rebinding): requests whose address is not
  `127.0.0.1`, `localhost`, another IP address of the computer, its Tailscale (`.ts.net`) or `.local` name or the
  configured public URL are answered "421" and
  go no further. If you reach harness-pilot through another name (a reverse proxy, a tunnel), add it with
  `pilot init --public-url https://<name>`, or list it in `allowed_hosts` in `config.json` or in the
  `MAXXING_ALLOWED_HOSTS` environment variable.
- Two-step sign-in is optional (Settings -> Security): a code from an authenticator app, an approval in a linked
  Telegram chat, or both (see **Sign-in** below).

### Where secrets are kept

- The local state lives in `.harness-pilot-local/state` inside the checkout (folder mode 700: other accounts of
  the computer cannot open it; `secrets.json` itself is mode 600).
  `secrets.json` holds the password hash, the cookie key, the Claude token or API key, the Telegram and GitHub
  tokens and your **Keys**. It is protected by file permissions, **not encrypted**: anything that runs as your
  user, an agent included, can read it. FileVault protects it while the computer is off.
- The API never returns a stored secret, except a Key you reveal on purpose. A Key marked **Expose** becomes an
  environment variable of every Claude turn and shell job: the agent and every command it runs can read it.
- **Protect the secrets** (Settings -> Claude, on by default) makes Claude's file tools refuse `secrets.json`,
  `~/.ssh` and the agents' own sign-ins (Codex's `auth.json`, Claude Code's `.credentials.json`); the agents
  themselves still use their own sign-in. For Claude it is a speed bump: a command written to open the file still
  can. For Codex it is enforced by Codex's own sandbox, so the commands Codex runs, scripts included, cannot read or
  change them either (checked on macOS and Linux). MCP servers run outside both agents' rules and can read them.
- The rest of the state folder is not covered, for either agent: the commands an agent runs can read the
  configuration, the session logs and the server's own SSH key for your other servers (`<state>/ssh`, see
  [Infra](infra)).
- Encrypted instance archives (Settings -> Backup) contain the secrets; the GitHub memory backup never does.

### What agents can do

Every agent process runs as your user, with your files, your network and the tools you are signed in to. There is
no operating-system isolation between harness-pilot and the agents it starts. What limits them:

- **Claude Code**: the permission mode of the session, topic or job. A new local workspace starts in `default`
  (Claude asks before edits and commands); `bypass` runs any command without asking.
- **Codex**: its own sandbox, chosen from the same mode: read-only in `default` and `plan`, workspace-write
  (writes limited to the working folder and temporary folders) otherwise. harness-pilot never starts Codex with
  unrestricted access. Reads are not limited, except `secrets.json`, `~/.ssh` and the agents' sign-in files with
  **Protect the secrets**. In every mode and every folder, the workspace root included, Codex cannot change what
  harness-pilot or Claude would run outside Codex's sandbox: the extensions (their `api.py` runs inside the server,
  as its user), the saved customization patches and `infra.json`, nor the settings of any topic or project folder:
  its permission mode (`.maxxing.json`), Claude Code's settings and hooks (`.claude/settings.json`,
  `.claude/settings.local.json`, `.claude/hooks/`) and `.mcp.json`. In the folders other than its own, Codex cannot
  read those settings either. So Codex cannot build or fix an extension: ask Claude. Claude in `bypass` can still
  write anywhere as your user, extensions included: that is what `bypass` means, so keep it for topics you trust.
- **Resident companions and missions**: each experiment works in a disposable copy of the committed source
  (`<state>/companions/runs/<id>/repo`, mode 700), with Claude's `acceptEdits` mode or Codex's workspace-write
  sandbox; an architect's plan runs read-only. The copy keeps ordinary edits away from the running app, but it is
  **not a sandbox**: what the agent may run is decided by its engine's permissions, not by the copy. A proposal is
  applied, published or merged only after your review. The optional **Sandbox** of Settings -> Companions (off by
  default) runs a Claude companion's commands in Claude Code's own sandbox: they can then write only in the copy
  and temporary folders and cannot reach the network (see [Resident companions](companions)).
- **External agent adapters** (agent extensions) are programs you install and trust. They run with your
  privileges and must enforce their own engine's permissions; harness-pilot cannot check that they do.
- **Shell jobs** run with your privileges, like a command typed in your terminal.

### Telemetry

Off by default (see **Privacy defaults** above): no request telemetry or OpenTelemetry export from the server, no
analytics from the Codex runs it starts, Claude Code started with its nonessential traffic off, and nothing sent to
the original project's services. Cloud agents still receive the prompts and files you give them, and the
integrations you configure (Telegram, GitHub) contact their own services.

### Good practice

- Keep the server on `127.0.0.1`. To reach it from another device, prefer an SSH tunnel (`ssh -L 8787:127.0.0.1:8787`)
  over opening the port, and keep the password strong.
- Turn on FileVault and lock your session when you leave the computer.
- Use `default` or `plan` for sessions that read untrusted content (web pages, e-mails, documents, issues); keep
  `bypass` for work you follow closely.
- Expose a Key only when an agent needs it, and prefer tokens with narrow rights and an expiry date.
- Install only adapters, extensions and skills you trust, and review a companion's proposal before approving it.
- Keep Claude Code, Codex and harness-pilot up to date.

## Linux server: Claude permissions

**Sessions, Claude jobs and shell jobs run as root, with full rights on the server.** By default `claude` runs
with `--dangerously-skip-permissions`: Claude can read and change any file (your secrets, SSH keys, other sites'
data), install software, change the firewall, start or stop services and run any command, without asking.
That is what makes unattended work, crons, server administration and phone conversations possible – and why
we recommend **a server dedicated to harness-pilot**, with no other critical service or data on it.

**The risks:** a malicious instruction hidden in content Claude reads (a web page, an e-mail, a document, a
forwarded message, a webhook) can make it act on the whole server; so can a mistake. Anyone who gets into the UI
or your Telegram chat gets the same power. Nothing on the server (deny rules, "Protect the secrets") stops
code that runs as root on purpose.

**What limits it:**
- **Permission modes, per topic and per job** (the real limit): `bypass` (default, no questions), `acceptEdits`
  (edits files, asks before commands), `default` (asks before edits and commands), `plan` (reads only, proposes a
  plan). Set them for the whole server (Settings -> Claude), a topic (topic menu -> **Permissions**) or a
  scheduled job. Put every topic and job that reads untrusted content in a stricter mode.
- Each session and job runs in its own systemd unit with a memory cap and a few protections that never get in
  the way of administering the server: it cannot set the system clock, change the process personality or use
  realtime scheduling (config `unit_hardening`, on for installations made from 2.0.0-alpha.70, off on older ones). These do not make root less than root.

A stricter mode costs refused actions in web sessions. See [Settings and keys](settings-and-keys).

Treat anything you paste into a session (documents, web pages, emails) as instructions Claude may
follow: do not feed it untrusted content with the bypass mode on. Topics and jobs that read the web, e-mails or
forwarded messages are the ones to put in a stricter mode.

**Protect the secrets** (Settings -> Claude, on by default) makes Claude's tools refuse to read or edit
`secrets.json`, `~/.ssh` and the agents' sign-in files (Codex's `auth.json`, Claude Code's `.credentials.json`) in
every mode. It is a speed bump, not a wall: a script written on purpose to open the file still can. Codex sessions
get the same paths denied by Codex's own sandbox, which a script does not get around. Codex's sandbox also keeps the
extensions and every folder's settings out of its reach in all modes (see [What agents can do](#what-agents-can-do)).

## Who can reach the UI

- The server listens only on `127.0.0.1` (behind Caddy) or on the Tailscale IP – **never** on
  `0.0.0.0` or a public address. `pilot doctor` fails if it does.
- **Domain mode**: HTTPS only (Caddy, Let's Encrypt), with HSTS, `X-Frame-Options: SAMEORIGIN`,
  `nosniff` and a strict referrer policy (the server sends the same headers itself, whatever the mode).
- **Tailscale mode**: only devices of your tailnet can connect.
- **Local mode**: only through an SSH tunnel.
- The server only answers requests addressed to one of its names (an IP address, `localhost`, a Tailscale `.ts.net` or `.local` name, the domain of the
  public URL, or a name of `allowed_hosts` / `MAXXING_ALLOWED_HOSTS`): a website that points its own domain at the
  server cannot use it (DNS rebinding).

## The server itself

The installer hardens the server (step "Server security"; `bash /opt/claude-maxxing/install.sh
--secure` re-applies it on an existing server):

- **Firewall (ufw)**: everything incoming is refused except SSH (the ports sshd really listens on
  are detected first, so you are never locked out), 80/443 in domain mode and the `tailscale0`
  interface in Tailscale mode. This matters here: if Claude starts a dev server or a quick file
  server on `0.0.0.0`, it stays private. To publish something on purpose: `ufw allow 3000/tcp`.
  Skip the firewall with `FIREWALL=0` (e.g. your provider's firewall already does the job).
  On a server already in use the default (`FIREWALL=auto`) is careful: the firewall is not turned on
  when other services are reachable from outside or Docker runs, and an active ufw keeps its rules
  (only the needed ports are added). `FIREWALL=1` forces the strict setup.
- **SSH by key only**: password logins (and keyboard-interactive) are turned off with
  `/etc/ssh/sshd_config.d/01-harness-maxxing.conf`; `PermitRootLogin yes` becomes `prohibit-password` (a stricter
  value is kept). Built so you cannot be locked out: by default it is done only when the session running the
  installer is proven, from the SSH log, to be a key login (an interactive install asks first); the new
  configuration is checked with `sshd -t` and removed if it does not validate or does not take effect; open
  sessions stay connected. Otherwise password logins stay on and the installer says why
  (`SSH_HARDEN=1 bash /opt/claude-maxxing/install.sh --secure` once you log in with a key; `SSH_HARDEN=0` never
  touches SSH). To undo: `rm /etc/ssh/sshd_config.d/01-harness-maxxing.conf && systemctl reload ssh`.
- **fail2ban**: an IP is banned for 1 hour after 5 failed SSH logins in 10 minutes
  (`fail2ban-client status sshd`; settings in `/etc/fail2ban/jail.d/harness-maxxing.local`).
- **Automatic security updates** (`unattended-upgrades`, daily).
- **Downloads**: nothing fetched from a third party runs before it is checked, and no script from the internet is
  piped into a shell. Every external component (uv, Python, Node.js, Claude Code, Scrapling and each Python package
  it needs, Chromium, Remotion, the speech models, Garage) has a pinned version and sha256 in
  `server/maxxing/deps.toml`, shipped with each signed release; Caddy's repository key must have the expected
  fingerprint and its apt source is written by the installer. A download that does not match installs nothing.
  `pilot deps verify` re-checks the installed binaries and that no file of them can be replaced by another user
  (the doctor does it too); `pilot deps check` looks the versions up in the osv.dev vulnerability database, and a
  weekly job notifies you when one is affected. Temporary files never go to the shared `/tmp`.
- **Memory**: the web service has its own memory limit (60 % of the RAM), sessions and scheduled jobs run in their
  own capped units, and oversized requests are refused before they are read.

- **Service sandbox**: the `claude-maxxing` service runs with systemd protections that cannot get
  in the way of the product (no new privileges, read-only kernel settings, no kernel modules or kernel
  log, read-only cgroups, no set-uid files, a cap on processes). They live in
  `/etc/systemd/system/claude-maxxing.service.d/10-hardening.conf`. Installs older than 2.0.0a32 get
  it with `pilot harden` (restarts the service; if it does not come back, the change is undone);
  `pilot harden --undo` removes it. The service still runs as root: Claude sessions run in their own
  units and are not limited by it (they get the lighter protections described at the top of this page).

Recommended on top: SSH keys instead of passwords (`PasswordAuthentication no` once your key works).
`pilot doctor` warns if any of the three is missing.

## Sign-in

- **Setup token**: the first visit requires the one-time link printed by the installer
  (`pilot setup-link`), so whoever finds the URL first cannot claim your instance. It is deleted
  once the password is set.
- **Password**: at least 12 characters for a new password (an older, shorter one still signs in), stored as a
  scrypt hash. Change it in Settings -> Security or with `pilot password` on the server; changing it signs every
  browser out. Wrong current passwords in that form are throttled like sign-ins.
- **Session cookie**: signed, `HttpOnly`, `SameSite=Strict`, `Secure` over HTTPS, valid 30 days.
  **Sign out** revokes that browser's cookie on the server too (a copied cookie stops working); your other
  browsers stay signed in. Live views already open in a signed-out browser (conversations, the dashboard's updates)
  stop within 15 seconds. To sign out **every** browser, change the password (Settings, or `pilot password`).
- **CSRF**: every change request must carry the `X-Maxxing: 1` header, which another website cannot
  send.
- **Request size**: a request from a browser that is not signed in is refused before the server reads it
  (the sign-in form itself takes at most 64 kB), and signed-in requests are capped too (1 MB, more for the file
  editor, messages to Claude and uploads), so nobody can fill the server's memory with a huge request. Live
  views (open conversations, dashboard updates) are capped as well: 24 per browser, 96 in total; past that, a view
  retries a few seconds later.
- **Throttling**: after a wrong password the next attempts are delayed (1, 2, 4, 8 s); after 8 wrong
  passwords that address is blocked for 15 minutes - even the right password is refused until then.
  If many addresses fail at once (more than 30 wrong passwords in 15 minutes), the server checks at
  most one password every 5 seconds for everyone: retry after a few seconds.
- **Alerts**: with Telegram linked, every sign-in and repeated wrong passwords are reported in the
  *Alerts* thread.
- **Two-step sign-in** (optional, Settings -> Security): after the right password, a browser that is not trusted
  yet also needs a code from an **authenticator app** (Google Authenticator, 1Password, Aegis... - time-based
  codes, RFC 6238), an approval in Telegram (see [Telegram](telegram#two-step-sign-in)), or either when both are
  on. Setting up the app shows a QR code and its key as text; it is switched on only once you type a code it shows
  and your password. Each code works once, even within its 30 seconds. Ten **recovery codes**, shown once when you
  turn the app on, each sign in once if you lose the phone; the server keeps only a fingerprint of them. **New
  recovery codes** (password and a code) replace them all, for example when few are left. The app's
  key is stored in `secrets.json` like the other secrets. Wrong codes count like Telegram codes (5 per request, 20
  in an hour on the whole server). Turning the app off asks for the password and a code (or a recovery code) and
  makes every trusted browser ask again. Without the UI: `pilot 2fa off` on the server turns both methods off.

## Telegram

The gateway answers only the chat linked with the one-time code, and only the Telegram account that opened
the link. A chat linked without its owner (by hand, or by a very old version) answers nobody - `pilot doctor`
warns, link it again from Settings -> Telegram. Anyone with access to that Telegram account can drive Claude:
protect it (2-step verification).

## What is stored where

| Path | Content | Protection |
|---|---|---|
| `/var/lib/claude-maxxing/config.json` | settings (no secrets) | directory mode 700 |
| `/var/lib/claude-maxxing/secrets.json` | password hash, cookie key, Claude token/API key, Telegram token, GitHub tokens, your Keys | mode 600; never returned by the API except on explicit Reveal |
| `/var/lib/claude-maxxing/sessions/` | session metadata and logs | mode 700 directory |
| `/root/maxxing/` | your workspace (memory, projects, tasks, extensions) | backed up (whitelist) |
| `~/.claude/` | Claude Code settings, CLI credentials, transcripts | Claude Code's own files |
| `/opt/claude-maxxing/` | the code (git clone) and its Python environment | replaced by updates |

Secrets never go to the backup: the backup copies a whitelist, refuses files like `.env` or keys,
scans for secret formats and refuses to push to a public repository.

## Files

The Files page and API only reach the *files root* (Settings -> General). Deleted files go to the
trash.

- Files open in the browser can never run scripts with your session: anything other than images,
  audio, video and PDF is shown in a sandbox.
- An **HTML page preview** link (valid 2 hours, ended by signing out - of that browser or of all of them) reaches
  the page's folder - only pages and their static assets (styles, scripts, pictures, fonts, audio, video), never
  notes, data or documents (`.md`, `.json`, `.txt`, `.csv`, `.pdf`...), code or settings (`.py`, `.env`, `.yaml`...),
  hidden files or folders (`.ssh`, `.claude`...); from a topic's `attachments/`, only pictures and videos. A page saved
  directly in the files root, the home folder, the workspace root, `projects/`, a project or its `topics/` folder
  (or in a hidden folder) is shown alone: its images and styles next to it do not load - move it into its own
  folder.
- **Ask harness-pilot** on a notification opens a session in **plan mode**: Claude reads and explains, it changes nothing
  until you approve a plan - a webhook's text cannot make it act.
- **Webhooks** refuse unknown links before reading anything, and any request over 1 MB.
- **Import** never brings Claude Code settings or hooks (`.claude/settings.json`, `.mcp.json`) from
  the archive; skills and notes are imported.

## Anthropic account

harness-pilot runs the official Claude Code CLI with **your** account or API key on **your**
server; it never shares or proxies credentials. Make sure your use complies with Anthropic's terms
for your plan.

## Checklist

- [ ] Dedicated server; SSH by key only, firewall, fail2ban and automatic security updates on (set by the installer).
- [ ] Domain (HTTPS) or Tailscale access; nothing reachable from the Internet but SSH, 80 and 443.
- [ ] SSH with a key (password login disabled).
- [ ] Strong UI password; Telegram account protected.
- [ ] Memory backup to a private repository.
- [ ] `pilot doctor` all green.
