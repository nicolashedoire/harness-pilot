# Audit de cohérence — 4 novembre 2026

Cet audit relève les écarts observés dans l'interface locale et le code. Il est un état des lieux de travail, pas une certification de toutes les fonctions. Les corrections seront cochées après vérification.

## Priorité 1 — informations ou destinations trompeuses

- [x] **Licence et accueil** : la page Licence présente la licence MIT et l'accueil ne demande plus de clé entreprise. Les avis historiques sont conservés.
- [ ] **Installation et mise à jour** : l'ancienne documentation et `install.sh` désignent encore le dépôt et le service d'installation d'origine. L'installation locale documentée dans le README utilise `scripts/dev-local.sh` ; les autres parcours n'ont pas encore été validés pour ce projet.
- [x] **Profil et feedback** : le formulaire d'enregistrement hérité a été retiré, le retour utilisateur ouvre les issues de ce dépôt, et le service d'enregistrement d'origine est désactivé par défaut, y compris pour une ancienne configuration.
- [x] **Dons** : le bouton ouvre le lien PayPal configuré par le propriétaire. Le bénéficiaire a été vérifié sur PayPal ; le lien peut être changé ou retiré dans Réglages → Soutenir.

## Priorité 2 — Claude et Codex

- [x] **Statistiques** : le quota affiché concerne Claude uniquement. Sur macOS, le message distingue désormais une connexion possible via le trousseau de l'indisponibilité de la lecture du quota.
- [ ] **Consommation** : les nouveaux tours sont maintenant ventilés par agent ; les tours plus anciens ou sans données restent non attribués. Les tarifs et quotas réels des abonnements ne peuvent pas être déduits d'un compteur de tokens ; il reste à examiner les données disponibles avant d'afficher un coût ou un quota Codex.
- [ ] **Comptage Codex** : les tours antérieurs à la correction pouvaient compter deux fois les tokens mis en cache. Les nouveaux tours distinguent les catégories ; les chiffres historiques ne sont pas recalculés automatiquement.
- [x] **Connexions et réglages** : une page Codex affiche le statut de la CLI et les limites actuelles ; la connexion a été vérifiée sur l'ordinateur.
- [ ] **Fonctions inégales** : plusieurs pages et indications supposent Claude ; vérifier pour chaque parcours si Codex, le dialogue et Telegram sont réellement pris en charge et signaler les limites.

## Priorité 3 — cohérence générale et documentation

- [ ] Reprendre les pages de documentation embarquées, les textes et liens hérités, ainsi que les notifications produites par le serveur, en conservant les attributions et licences applicables.
- [ ] Vérifier les fonctions de mémoire, tâches, automatisations et sauvegardes avec les deux agents ; préserver les données existantes.
- [ ] Vérifier les écrans sur ordinateur et mobile, les états d'erreur, l'accessibilité et les traductions.
- [ ] Ajouter des tests ciblés pour les corrections, puis valider les parcours dans l'interface locale.
