# Contributing

Contributions are welcome. They must be distributable under the [MIT license](LICENSE) and respect the licenses of the dependencies and the rights of third parties.

For a fix or an improvement, open an issue or a pull request in this repository. Describe the problem, the change and how to verify it. Never publish a password, token, personal data or excerpt of a confidential session.

For the server:

```sh
cd server
uv sync --locked
uv run pytest
```

For the interface (Node.js 22 or later):

```sh
cd web
npm ci
npm run typecheck
npm run build
```

The built files in `web/dist` are tracked by Git: include them when the interface changes. Update the user documentation and the French and English translations when needed. For tests, use an isolated workspace and simulated services rather than your real crontab or bots.

The project keeps the notices of the previous authors and of third-party components in [LICENSE.original](LICENSE.original) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
