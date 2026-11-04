# Audit de cohérence — 4 novembre 2026

Cet audit relève les écarts observés dans l'interface locale et le code. Il est un état des lieux de travail, pas une certification de toutes les fonctions. Les corrections seront cochées après vérification.

## Priorité 1 — informations ou destinations trompeuses

- [x] **Licence et accueil** : la page Licence présente la licence MIT et l'accueil ne demande plus de clé entreprise. Les avis historiques sont conservés.
- [ ] **Installation et mise à jour** : `install.sh` est désactivé tant que son parcours Linux et ses destinations héritées ne sont pas adaptés et validés. L'installation locale documentée dans le README utilise `scripts/dev-local.sh` ; les autres parcours n'ont pas encore été validés pour ce projet.
- [x] **Profil et feedback** : le formulaire d'enregistrement hérité a été retiré, le retour utilisateur ouvre les issues de ce dépôt, et le service d'enregistrement d'origine est désactivé par défaut, y compris pour une ancienne configuration.
- [x] **Dons** : le bouton ouvre le lien PayPal configuré par le propriétaire. Le bénéficiaire a été vérifié sur PayPal ; le lien peut être changé ou retiré dans Réglages → Soutenir.

## Priorité 2 — Claude et Codex

- [x] **Statistiques** : le quota affiché concerne Claude uniquement. Sur macOS, le message distingue désormais une connexion possible via le trousseau de l'indisponibilité de la lecture du quota.
- [ ] **Consommation** : les nouveaux tours sont maintenant ventilés par agent ; les tours plus anciens ou sans données restent non attribués. Les tarifs et quotas réels des abonnements ne peuvent pas être déduits d'un compteur de tokens ; il reste à examiner les données disponibles avant d'afficher un coût ou un quota Codex.
- [x] **Montants Claude** : les montants affichés sont signalés comme indicatifs et ne prétendent plus déterminer la facturation. Les crédits d'utilisation peuvent entraîner des frais supplémentaires ; la facture réelle reste à consulter auprès d'Anthropic. Codex n'est pas inclus dans ce montant.
- [ ] **Comptage Codex** : les tours antérieurs à la correction pouvaient compter deux fois les tokens mis en cache. Les nouveaux tours distinguent les catégories ; les chiffres historiques ne sont pas recalculés automatiquement.
- [x] **Connexions et réglages** : une page Codex affiche le statut de la CLI et les limites actuelles ; la connexion a été vérifiée sur l'ordinateur.
- [x] **Santé des agents** : si Codex est connecté, l'absence de connexion Claude est une information plutôt qu'une panne générale ; Claude reste nécessaire pour l'utiliser et pour les discussions à deux.
- [x] **Synthèse des échanges** : le menu d'une session propose un résumé, les décisions et des actions à sélectionner avant toute création de tâche. L'essai réel a été effectué avec Codex ; le coût de cet appel n'est pas encore intégré aux statistiques.
- [x] **Mémoire partagée** : depuis la synthèse, le texte peut être relu et modifié avant ajout explicite à la mémoire du sujet. Codex la lit au prochain tour ; Claude la charge normalement au démarrage d'un nouveau fil. Les écritures refusent les liens symboliques et une mémoire trop volumineuse pour Codex.
- [x] **Connexions des sessions** : les conversations utilisent des requêtes courtes ; les onglets compatibles partagent une connexion d'actualisation et prennent le relais si elle ferme. Essai local avec plusieurs onglets ; les navigateurs sans coordination conservent une connexion par onglet.
- [ ] **Fonctions inégales** : plusieurs pages et indications supposent Claude ; vérifier pour chaque parcours si Codex, le dialogue et Telegram sont réellement pris en charge et signaler les limites.
- [ ] **Navigateur de l'ordinateur** : aucun binaire d'agent n'est publié dans le manifeste ; son URL héritée pointe vers le projet d'origine. Le code compile pour ce Mac et ses tests Go passent ; le jumelage et le pilotage réels restent à vérifier avant de proposer son installation.

## Priorité 3 — cohérence générale et documentation

- [x] **Système sur macOS** : la mémoire estimée, la charge et le temps de fonctionnement sont relevés sur le Mac. Les données indisponibles ne sont plus affichées à zéro ; les commandes systemd et les mises à jour automatiques non validées sont masquées et bloquées en mode local.
- [x] **Tableau de bord** : la carte serveur distingue les mesures indisponibles, les textes des cartes ne désignent plus les agents par l'ancien nom et le quota Claude n'affirme plus que le compte est déconnecté.
- [x] **Tâches planifiées en local** : un planificateur indépendant de la crontab système lance les tâches pendant que l'application fonctionne. Les exécutions manquées et `@reboot` ne sont pas prises en charge ; les prompts planifiés utilisent Claude Code.
- [ ] **Reprise après interruption sur macOS** : si un processus de tâche devient orphelin, son identité ne peut pas encore être vérifiée avec la méthode Linux ; il n'est donc pas arrêté automatiquement pour éviter de tuer un autre processus.
- [ ] **Chemins internes hérités** : certains liens utilisent encore le sujet système historique. Une migration doit préserver les projets, les sessions et les extensions existants.
- [ ] Reprendre les pages de documentation embarquées, les textes et liens hérités, ainsi que les notifications produites par le serveur, en conservant les attributions et licences applicables.
- [x] **Documentation critique** : les pages mémoire, sécurité, Telegram et commandes distinguent les comportements vérifiés en local des fonctions héritées non encore validées.
- [x] **Navigation de la documentation** : les liens entre guides, y compris les noms de fichiers Markdown et les renvois vers une section, sont utilisables dans l'application ; les licences et l'audit ouvrent les fichiers du dépôt.
- [ ] Vérifier les fonctions de mémoire, tâches, automatisations et sauvegardes avec les deux agents ; préserver les données existantes.
- [x] **Tests isolés des tâches et sauvegardes** : 92 tests passent sur macOS avec un GitHub simulé ; un test de nom de fichier non UTF-8 est ignoré lorsque le système de fichiers l'interdit. Cela ne valide pas une sauvegarde réelle du compte utilisateur.
- [x] **Tests isolés Telegram** : 43 tests de format, de synchronisation et de connexion passent avec des services simulés ; une connexion et une discussion réelles avec un bot restent à vérifier.
- [ ] Vérifier les écrans sur ordinateur et mobile, les états d'erreur, l'accessibilité et les traductions. Le formulaire de discussion à deux a été contrôlé visuellement en largeur mobile ; un premier contrôle de largeur a aussi été effectué sur les statistiques, Codex, Telegram, Soutenir et le guide des sessions. Les autres parcours restent à examiner.
- [ ] Ajouter des tests ciblés pour les corrections, puis valider les parcours dans l'interface locale.
