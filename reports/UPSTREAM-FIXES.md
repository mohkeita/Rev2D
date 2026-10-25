# Corrections des échecs amont — 25 octobre 2026

À la demande de l’utilisateur, les échecs de la référence sont corrigés avant de commencer la phase 1. Révision de code : `a6f30ef` ; les commits de rapport suivants ne changent pas le code exécuté.

## Causes et corrections

| Échec | Cause constatée | Correction |
| --- | --- | --- |
| Détection du faux agent Codex | Le test isolait `PATH` dans un répertoire contenant le faux agent, mais pas l’interpréteur de son shebang `env node`. | La fixture POSIX ajoute un lien vers `process.execPath`. Aucun agent réel n’est exécuté. |
| Démarrage sur `127.0.0.2` | Cette adresse nécessite un alias réseau sur macOS. | L’intégration démarre sur `localhost` ; les tests du prédicat continuent à couvrir les adresses `127/8`. Les contrôles des hôtes externes restent testés. |
| Lecture d’une texture avec des antislashs | Le chemin Windows était résolu comme un nom de fichier POSIX. | L’API avatar normalise les séparateurs avant résolution et confinement. Tests ajoutés pour les chemins mixtes. |
| Traversée du dossier avec des antislashs | La même résolution incorrecte produisait une mauvaise classification de l’erreur. | Le confinement s’applique au chemin normalisé ; traversées mixtes et fichiers cachés sont testés. Le contrôle des liens symboliques reste actif. |
| Clic dans la timeline | La réponse HTTP confirme l’envoi SSE, alors que la commande peut encore attendre son application dans le navigateur. Le test cliquait parfois dans la timeline de l’animation précédente. | Attendre l’état effectif du navigateur et la durée de l’animation avant de cliquer. L’assertion sur la position finale reste inchangée. |
| Glissement d’une feuille modale | Une boîte englobante mesurée pendant le retour animé devenait périmée avant le clic. Le clic touchait alors le titre. | Le locator Playwright attend la stabilité et place le pointeur sur la poignée avant le glissement. Les distances et les assertions de fermeture restent inchangées. |

La dernière suite générale a aussi reproduit le **septième échec intermittent déjà observé dans la référence initiale** : la validation de 2 000 références inconnues prenait 2 162 ms, au-delà du seuil de 2 000 ms. La recherche de suggestions rejette désormais une paire dès que le nombre de caractères de l’entrée absents du candidat dépasse le budget d’édition. Chaque caractère absent nécessite au moins une suppression ou substitution ; ce rejet préserve donc les résultats.

Trois tests supplémentaires comparent les suggestions à un calcul complet de distance d’édition : chaînes courtes avec différents ordres de candidats, égalités, répétitions, casse, Unicode et identifiants longs. Aucun seuil n’a été relevé et aucun test n’a été désactivé.

## Reproduction et contrôles ciblés

Avant correction, les trois fichiers Node ciblés reproduisent les quatre échecs correspondants. Les deux échecs d’interface se reproduisent en exécutant leurs fichiers entiers ; isolés, les deux cas passent, ce qui a permis d’identifier les courses liées à l’état et aux animations.

- Serveur et faux agents : **101 réussis, 1 ignoré** dans 3 fichiers, 13,71 s. Le cas ignoré est réservé à Windows.
- Interface : **27 réussis** dans les deux fichiers complets, 118,43 s.
- Validation et suggestions après optimisation : **118 réussis** dans 2 fichiers, 1,11 s.
- Suite générale après les six premières corrections, avant optimisation : **2 731 réussis, 1 échec, 2 ignorés**, 385,27 s. Le seul échec était la performance des suggestions.

Commandes ciblées :

```sh
node node_modules/vitest/vitest.mjs run --project node test/agent-bridge.test.ts src/server/__tests__/agent.test.ts src/server/__tests__/avatar.test.ts
node node_modules/vitest/vitest.mjs run --project chrome test/editor-e2e.test.ts test/editor-design-e2e.test.ts
node node_modules/vitest/vitest.mjs run --project node src/core/__tests__/validate.test.ts src/core/__tests__/validate-text.test.ts
```

## Validation finale

`npm run typecheck`, `npm run build`, puis `npm test` ont été exécutés successivement sur la dernière révision, avec un code de sortie **0** pour chacun. Le build inclut l’éditeur (778 ms). Résultat brut de la suite complète :

```text
 Test Files  149 passed (149)
      Tests  2735 passed | 2 skipped (2737)
   Start at  19:26:04
   Duration  397.34s (tests 87%, import 10%, transform 3%)
```

La suite complète ne présente plus aucun échec. Les deux cas ignorés étaient déjà ignorés dans la livraison initiale ; les corrections n’ajoutent aucun mécanisme d’exclusion. Les journaux bruts et les contrôles ciblés sont conservés localement sous `out/demo-phase0/upstream-fixes/`.

Les modifications touchent le confinement des chemins et la performance de validation en production, ainsi que les fixtures et la synchronisation des tests. Elles ne constituent pas une livraison de la phase 1.
