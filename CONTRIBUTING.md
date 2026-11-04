# Contribuer

Les contributions sont bienvenues. Elles doivent pouvoir être distribuées sous la [licence MIT](LICENSE) et respecter les licences des dépendances et les droits des tiers.

Pour une correction ou une amélioration, ouvrez une issue ou une pull request dans ce dépôt. Décrivez le problème, le changement et la manière de le vérifier. Ne publiez jamais de mot de passe, jeton, donnée personnelle ou extrait de session confidentiel.

Pour le serveur :

```sh
cd server
uv sync --locked
uv run pytest
```

Pour l'interface (Node.js 22 ou plus récent) :

```sh
cd web
npm ci
npm run typecheck
npm run build
```

L'intégration continue (`.github/workflows/ci.yml`) lance ces mêmes commandes sur chaque pull request et chaque push sur `main` : `uv run pytest` dans `server/`, puis `npm ci`, `npm run typecheck`, `npm test` et `npm run build` dans `web/`. Elle échoue si le `web/dist` reconstruit diffère de celui de la pull request. Les tests qui demandent un outil absent de l'environnement (par exemple `ffmpeg`) sont ignorés avec une condition précise plutôt que retirés.

Les fichiers construits de `web/dist` sont suivis par Git : incluez-les lorsque l'interface change. Actualisez la documentation utilisateur et les traductions française et anglaise lorsque nécessaire. Pour les tests, utilisez un espace isolé et des services simulés plutôt que votre crontab ou vos bots réels.

Le projet conserve les avis des auteurs précédents et des composants tiers dans [LICENSE.original](LICENSE.original) et [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
