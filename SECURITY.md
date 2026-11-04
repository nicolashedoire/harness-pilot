# Security policy

harness-pilot runs Claude Code and Codex with wide permissions on your computer or server, so security reports matter a lot to us.
Thank you for reporting responsibly.

## Report a vulnerability privately

**Never open a public issue, discussion or pull request for a vulnerability.** Use GitHub private vulnerability
reporting: on the repository, *Security* -> *Report a vulnerability*
([direct link](https://github.com/nicolashedoire/harness-pilot/security/advisories/new)).

Please include:

- the version (`pilot status`) and how harness-pilot is installed (Linux server or local copy);
- what an attacker can do, and from where (internet, the local network, another user of the server, a session);
- the steps to reproduce, or a proof of concept;
- any idea of a fix.

## What happens next

- We acknowledge the report within **3 working days** and keep you informed.
- We confirm the issue, prepare a fix and release it; the changelog credits you unless you prefer otherwise.
- Please give us a reasonable time to ship the fix (90 days at most) before any public disclosure.

## Supported versions

Only the latest version receives security fixes: the `main` branch, which installs follow (there is no `stable`
branch, tag or release). Update a Linux server with `pilot update`, and a local copy by pulling `main`.

## Scope

In scope: the server (`server/`), the web UI (`web/`), the installer (`install.sh`), the PC agent (`pc-agent/`),
the shipped skills and templates. Out of scope: what Claude Code or Codex does with the permissions you gave it on
your own computer or server, vulnerabilities of third-party components that are already fixed upstream (tell us if
we ship an old version), and reports from automated scanners without a demonstrated impact.
