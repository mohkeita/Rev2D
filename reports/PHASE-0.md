# Phase 0 — bibliothèque d’assets

**Statut : critères techniques de phase 0 satisfaits, avec les échecs amont explicitement conservés.** La revue artistique reste distincte de la validation technique. Les phases 1 à 4 ne sont pas livrées par cette PR.

## Révisions et périmètre

- Départ : `f144581cdf1f12d781379c4df90d262b8c2dfa3d`.
- Code vérifié : `9b62370ce1a55500cc2e2a280a550e852ecfec5c`. Les commits suivants ne font qu’ajouter les rapports.
- Branche locale : `codex/phase-0-library-public` ; branche de PR : `phase-0-library`.
- Fork : https://github.com/mohkeita/Rev2D ; base de PR : son `main`, au commit de départ.
- Les prototypes antérieurs sont conservés localement ; ils ne sont pas présentés comme une phase 1 conforme.
- Le brief privé et tout l’art utilisateur restent locaux, dans les sources fournies et `out/demo-phase0/`. Ils ne sont pas publiés dans l’historique de cette branche.

## Environnement et référence avant modification

macOS x86_64, Node v24.21.0, npm 11.19.0, dépendances du lockfile inchangées.
Une copie du commit amont a été extraite par `git archive` dans `/private/tmp/rev2d-studio-baseline-f144581`, avec les mêmes dépendances installées. Commande exécutée dans cette copie :

```sh
npm run typecheck > /private/tmp/rev2d-baseline-typecheck.log 2>&1 && npm run editor:build > /private/tmp/rev2d-baseline-editor.log 2>&1 && npm test > /private/tmp/rev2d-baseline-tests.log 2>&1
```

Résumé brut de la référence :

```text
 Test Files  6 failed | 138 passed (144)
      Tests  7 failed | 2705 passed | 3 skipped (2715)
   Start at  17:07:15
   Duration  408.27s (tests 87%, import 10%, transform 4%)

```

La référence Linux du brief ne comptait que le projet node ; cette mesure comprend aussi Chrome.

## Vérifications finales — commandes et sorties brutes

```sh
npm run typecheck
npm run build
npm test
```

Typecheck : code de sortie 0.

```text
> rev2d@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
```

`npm run build` inclut la compilation TypeScript et `npm run editor:build` ; code de sortie 0. Fin de sortie brute :

```text
dist/editor/assets/sheet-CjQxasWt.css       66.26 kB │ gzip:  12.23 kB
dist/editor/assets/index-P815CN5D.css       91.29 kB │ gzip:  14.27 kB
dist/editor/assets/api-CHcmnbCu.js           1.94 kB │ gzip:   0.94 kB │ map:     9.97 kB
dist/editor/assets/gallery-DmGu1DPB.js     119.91 kB │ gzip:  28.08 kB │ map:   171.21 kB
dist/editor/assets/sheet-DIy-Vl89.js       527.10 kB │ gzip: 170.57 kB │ map: 2,466.99 kB
dist/editor/assets/index-BQrmCum8.js       825.68 kB │ gzip: 257.17 kB │ map: 2,728.19 kB

✓ built in 862ms
```

Suite complète : code de sortie 1, à cause d’échecs présents avant modification. Aucun test n’a été désactivé pour masquer ces échecs.

```text
 Test Files  5 failed | 143 passed (148)
      Tests  6 failed | 2726 passed | 2 skipped (2734)
   Start at  18:28:50
   Duration  394.67s (tests 88%, import 9%, transform 3%)

```

Comparaison des noms de tests en échec : référence 7, courant 6, **nouveaux 0**.
Les variations du test de performance et des tests Chrome entre deux exécutions ne sont pas présentées comme des corrections.

Échecs courants :

- `|chrome| test/editor-design-e2e.test.ts > design-system gallery end to end (built UI + Chrome) > traps the focus in a sheet, closes on Escape and gives the focus back; an alert never defaults to the destructive action`
- `|chrome| test/editor-e2e.test.ts > editor screenshots match the WebGL viewport (hana) > scrubs the timeline, and works the outline rows: context menu, inspect, preview visibility`
- `|node| src/server/__tests__/agent.test.ts > agent bridge: who may use it > a non-loopback bind disables the agent endpoints unless allowAgent is set`
- `|node| src/server/__tests__/avatar.test.ts > GET /api/avatar/file > refuses everything outside the project, hidden files and types a browser would run`
- `|node| src/server/__tests__/avatar.test.ts > GET /api/avatar/file > serves the files of the project with their types, revalidated by ETag`
- `|node| test/agent-bridge.test.ts > jobs > starts a CLI found on PATH as the platform installs it (npm .cmd shim / executable script), without a shell`

Les journaux complets restent dans `out/demo-phase0/verification/` et `out/demo-phase0/baseline/`.

## Chaque critère d’acceptation

| Critère | Statut | Commande / preuve |
| --- | --- | --- |
| 1. Aucun nouvel échec, typecheck et éditeur | OK par comparaison amont | Commandes et sorties ci-dessus ; `regressions.json` donne `newFailures: []`. La suite reste non verte à cause des échecs amont. |
| 2. IoU ≥ 0,98 sur vert/blanc, contours, despill | OK | `node node_modules/vitest/vitest.mjs run src/library/__tests__/key.test.ts` : 10 tests ; quatre poses × deux fonds, PNG identiques à entrée identique et original inchangé. Démo : IoU minimale 0.99220000, part verte maximale 0. |
| 3. Fond bruité / sujet coupé | OK | Le même fichier de tests vérifie `library-key-background-noisy`, `library-key-subject-touches-border`, pointeur et hint. |
| 4. Fichier manquant, doublon, pose non construite, ancre inconnue, paramètres incohérents | OK | `node node_modules/vitest/vitest.mjs run test/library.test.ts` : cinq tests, construction de vrais avatars, édition de sources/modèles et vérification des diagnostics ; UI, props et bulles également exercés. |
| 5. Recherche tags/texte | OK | `test/library.test.ts` : tags tous requis, personnage et texte français accentué ; exemple local `library search ... --character C1 --tags sitting,phone --json` retourne la pose prévue. |
| 6. Onze outils MCP testés, descriptions < 2 048 | OK | `node node_modules/vitest/vitest.mjs run test/library-tools.test.ts src/mcp/__tests__/server.test.ts` ; tous les onze outils sont appelés avec de vrais fichiers/PNG/modèle construit. Découverte : 29 outils, 11 ajoutés, description ajoutée maximale 295 caractères. Guide et sujet docs library à jour. |
| 7. Bibliothèque de fixtures et assets utilisateur, planches | OK technique | Commandes ci-dessous : huit entrées synthétiques ; salon et C1/C2 dans trois poses chacun, avatars construits, six fois zéro pli, bibliothèque utilisateur sans diagnostic. Les feuilles poses/turn/eyes/mouth ont été inspectées ; limites visuelles explicitées ci-dessous. |

Compilation navigateur supplémentaire : `node node_modules/vitest/vitest.mjs run test/library-browser.test.ts` passe, sans shim Node dans l’API pure.

### Démonstration reproductible depuis un checkout

Choisir un dossier neuf :

```sh
node --import tsx scripts/demo-library.ts out/demo-phase0/synthetic-rebuilt
node bin/rev2d.js library validate out/demo-phase0/synthetic-rebuilt/library --json
node bin/rev2d.js library sheet out/demo-phase0/synthetic-rebuilt/library -o out/demo-phase0/synthetic-rebuilt-sheet.png --json
```

Exécution réelle équivalente dans `out/demo-phase0/synthetic-complete`, sortie :

```text
standing: 0 fold findings
standing_point: 0 fold findings
sitting: 0 fold findings
sitting_phone: 0 fold findings
{"directory":"/Users/mohamedkeita/Desktop/serie animate/ai drama/rev2d-test/out/demo-phase0/synthetic-complete","validation":{"ok":true,"diagnostics":[]},"minimumIoU":0.9922282161470238,"maximumGreenShare":0}
```

Contenu : quatre poses de figure, une pièce, un carton, une bulle de pensée, un modèle de téléphone avec Progress. Sources vertes, blanches et transparentes, métriques et revues incluses. Aucun art utilisateur dans ces fixtures.

### Démonstration utilisateur locale

Six PNG de poses ont été générés via l’outil natif image_gen, avec les fiches canoniques réellement jointes. Les prompts et références copiées sont sous `out/demo-phase0/requests/`. Aucun appel réseau n’a été ajouté à Rev2D. Le salon diurne existant a été décodé sans retouche de JPG vers PNG.

```sh
node bin/rev2d.js library validate out/demo-phase0/user-library --json
node bin/rev2d.js library search out/demo-phase0/user-library --character C1 --tags sitting,phone --json
```

Sortie de validation :

```json
{ "ok": true, "diagnostics": [] }
```

La lecture des coordonnées a été testée avant placement : `avatar vision-check make ... --seed 7`, puis réponses lues visuellement et `avatar vision-check score ...` : moyenne 0,28 px, maximum 1,41 px, succès. Les repères de C1 pointant ont ensuite été affinés avec les contours réels en pixels.

Régénération locale des projets à partir des PNG conservés : voir `out/demo-phase0/README.md`. Ces scripts privés ne remplacent pas les fixtures reproductibles du dépôt public. Leurs résultats sont dans `user-rig-report.json`, `user-anchors.json` et les six dossiers `review/`.

## Fichiers créés / modifiés

- `AGENTS.md` — Guide de développement et outils avatar/bibliothèque.
- `README.md` — Présentation, compte des 43 commandes / 29 outils et accès à la bibliothèque.
- `docs/ARCHITECTURE.md` — Frontières des nouveaux modules purs et de leur IO.
- `docs/AVATAR.md` — Workflow bibliothèque et six outils MCP avatar.
- `docs/CLI.md` — Huit commandes library, options et sorties.
- `docs/LIBRARY.md` — Format, import, détourage, requêtes, diagnostics, provenance et démo.
- `docs/MCP.md` — Paramètres et résultats des onze nouveaux outils.
- `docs/OPS.md` — Personnalisation des avatars via post ops et reconstruction.
- `docs/SPEC.md` — Lien vers le format de bibliothèque distinct du modèle v1.
- `examples/README.md` — Fixtures originales et commande de démonstration.
- `llms.txt` — Index de documentation pour agents.
- `scripts/demo-library.ts` — Démo reproductible de toutes les catégories et métriques de détourage.
- `scripts/examples/figure.ts` — Personnage vectoriel original en quatre poses et articulations connues.
- `scripts/examples/phone-ui.ts` — Téléphone vectoriel piloté par Progress.
- `scripts/examples/room.ts` — Décor vide vectoriel original.
- `src/cli/commands/index.ts` — Enregistrement des commandes et du parent library.
- `src/cli/commands/library.ts` — Adaptateurs CLI et erreurs machine structurées.
- `src/cli/commands/reference.ts` — Sujet docs library.
- `src/index.ts` — Exports publics des API de bibliothèque.
- `src/library/__tests__/key.test.ts` — Vérité terrain des quatre poses sur vert/blanc, IoU, spill et déterminisme.
- `src/library/index.ts` — Point d’entrée pur, utilisable dans un navigateur.
- `src/library/key.ts` — Détourage Lab, connexité, alpha, despill, recadrage et avertissements.
- `src/library/prompts.ts` — Prompts déterministes et demandes de génération sans réseau.
- `src/library/schema.ts` — Schéma versionné, diagnostics et ids dupliqués.
- `src/library/search.ts` — Recherche par type, personnage, tags et texte sans accents/casse.
- `src/mcp/__tests__/server.test.ts` — Inventaire complet des 29 outils.
- `src/mcp/guide.ts` — Workflow et liste des nouveaux outils.
- `src/mcp/server.ts` — Enregistrement des onze outils.
- `src/mcp/tools/docs.ts` — Sujet library dans rev2d_docs.
- `src/mcp/tools/library.ts` — Cinq outils bibliothèque et six enveloppes avatar, PNG inline.
- `src/node/library.ts` — Fichiers, import transactionnel, verrous, provenance, validation et planches.
- `test/docs-commands.test.ts` — Validation des commandes citées dans LIBRARY.md.
- `test/fixtures/studio.ts` — PNG synthétiques, alpha de référence, props et repères avatar connus.
- `test/library-browser.test.ts` — Compilation de toute l’API pure pour navigateur sans shim Node.
- `test/library-tools.test.ts` — Cycle réel des onze outils MCP et des huit commandes CLI.
- `test/library.test.ts` — Import, recherche, fichiers/avatars/ancres/paramètres, provenance, UI et confinement.
- `reports/PHASE-0.md` — preuves, écarts et limites de cette phase.
- `reports/OBJECTIFS.md` — progression des phases.

## Écarts, limites connues et suite

- Le détourage est chromatique, pas une segmentation sémantique. Une zone blanche enfermée peut être le visage ou le fond : elle est conservée. Une couleur du vêtement identique au fond est ambiguë et signalée. Certains espaces entre doigts/bras des assets utilisateur donnent des avertissements de trous/couleur à relire ; ils ne sont pas masqués.
- `library rig` construit le projet avatar créé par import ; les repères sont à mesurer, jamais inventés automatiquement. Les empreintes couvrent source, spec, modèle et textures ; un avatar construit par la CLI amont doit passer une fois par library rig pour obtenir ces empreintes.
- Les six poses utilisateur sont des dessins de corps entier avec les contrôles faciaux/amont. Leurs bras et mains ne sont pas articulés par cette phase. Les ancrages d’assise sont approximatifs ; les pieds et hauteurs de référence sont mesurés sur l’alpha.
- Les paupières complètement fermées des assets utilisateur ont une correction vectorielle locale via les post ops existantes. Les demi-fermetures de C1 restent simplifiées/anguleuses ; des variantes dessinées et le jeu d’acteur restent à traiter. Les rotations sont volontairement petites, sans promesse de profil 3D ou de fidélité pixel à pixel aux clips vidéo.
- Les nouvelles poses demandent une appréciation artistique de l’identité/proportions. Un modèle techniquement valide ne vaut pas approbation artistique.
- Aucun nouvel algorithme tiers copié, aucune dépendance npm ajoutée, aucune modification du moteur, du schéma modèle ou de l’éditeur web. Les conversions Lab utilisent les utilitaires MIT déjà présents dans Rev2D.
- La phase 1 ajoutera les scènes/narration/caméra/export ; la phase 2, les bras/mains/gestes/expressions ; la phase 3, l’épisode ; la phase 4, les looks. Le lip-sync n’est pas implémenté et reste optionnel.
