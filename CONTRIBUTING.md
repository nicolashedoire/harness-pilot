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

Les fichiers construits de `web/dist` sont suivis par Git : incluez-les lorsque l'interface change. Actualisez la documentation utilisateur et les traductions française et anglaise lorsque nécessaire. Pour les tests, utilisez un espace isolé et des services simulés plutôt que votre crontab ou vos bots réels.

Le projet conserve les avis des auteurs précédents et des composants tiers dans [LICENSE.original](LICENSE.original) et [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
