# Phase 3 — storyboard, rendu et montage

**Moteur livré ; le montage EP011 reste un prototype dont seize plans doivent recevoir leur animation propre.**

La phase ajoute un pipeline de narration → storyboard → scènes complètes → MP4 par plan → montage
avec transitions et audio, cache vérifié, rapports et export vertical. Elle conserve les scènes auteurs
et leurs gestes/z order. Aucun ancien clip utilisateur n’est substitué à un rendu Rev2D.
La phase 4 n’est pas engagée.

## Révisions et environnement

- Départ : `9882afe118206cdfd05ed51dd6a301c08c3789c0`, phase 2.
- Code et documentation vérifiés : `11ceb109754a83b48bbc1f2d7646c2c7a74c1cfb` ; présent rapport et tableau
  de progression livrés dans le commit documentaire suivant.
- Branche : `phase-3-episode` ; PR brouillon sur `mohkeita/Rev2D`, base `phase-2-acting`.
- Commits : `668f106` (contrat pur), `1318e65` (IO/rendu/cache/montage), `a39636b` (CLI/MCP),
  `11ceb10` (exemple et guide testé).
- macOS x86_64, Node v24.21.0, npm 11.19.0, ffmpeg et ffprobe locaux.
- Aucune dépendance npm ajoutée ; aucun service de génération, modèle vidéo ou appel réseau dans
  le moteur. Les images et la voix EP011 restent dans `out/`, ignoré par Git.

## Vérifications finales

Commandes, après les exports et avant la charge Chrome de la suite :

```sh
npm run typecheck
npm run build
node --import tsx out/demo-phase3/prove-cache.ts
python3 out/demo-phase3/verify-media.py
npm test
```

La suite complète utilise l’autorisation de service local pour les tests d’éditeur. Le premier essai
restreint a échoué sur les sockets/watch interdits par le bac à sable ; il n’est pas présenté comme
un résultat final. Les exports et les autres tests Chrome ne sont pas exécutés en parallèle.
Les journaux complets sont `out/demo-phase3/final-typecheck.log`, `final-build.log`, `final-tests.log`.

Typecheck, sortie brute :

```text
> rev2d@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
```

Build (compilation TypeScript et éditeur), extraits bruts :

```text

> rev2d@0.1.0 build
> tsc -p tsconfig.build.json && npm run editor:build


> rev2d@0.1.0 editor:build
> vite build --config editor/vite.config.ts

vite v8.3.1 building client environment for production...
transforming...
✓ 455 modules transformed.
rendering chunks...
dist/editor/assets/index-K3wm26DB.js       862.90 kB │ gzip: 268.30 kB │ map: 2,828.77 kB

✓ built in 1.11s
```

Suite complète, résumé brut :

```text
Test Files  164 passed (164)
      Tests  2861 passed | 2 skipped (2863)
   Start at  20:35:40
   Duration  441.09s (tests 87%, import 10%, transform 3%)
```

## Critères d’acceptation

### 1. Tests, typecheck, éditeur et documentation — OK

Les commandes ci-dessus vérifient tous les modules, puis Chrome dans un groupe séquentiel.
`test/episode-browser.test.ts` bundle la totalité de l’API pure ; `test/docs-links.test.ts` et
`test/docs-commands.test.ts` incluent le guide épisode. `test/episode-tools.test.ts` exécute les sept
outils MCP sur de vrais fichiers et vérifie les erreurs CLI 1/2.

Contrôle ciblé :

```sh
node --import tsx node_modules/vitest/vitest.mjs run test/docs-links.test.ts test/docs-commands.test.ts src/episode/__tests__/episode.test.ts test/episode-browser.test.ts test/episode-tools.test.ts --project node
```

Sortie : 5 fichiers réussis, 35 tests réussis (`out/demo-phase3/docs-tools-tests.log`).

### 2. Exemple original complet — OK

```sh
node bin/rev2d.js episode validate examples/episodes/demo/storyboard.json --json
node bin/rev2d.js episode build examples/episodes/demo/storyboard.json -o out/demo-phase3/example-final --json
node bin/rev2d.js episode render out/demo-phase3/example-final --jobs 2 --json
node bin/rev2d.js episode assemble out/demo-phase3/example-final -o out/demo-phase3/example-final.mp4 --json
```

Sorties : validate `{ok:true, frames:288, duration:12, missing:[], diagnostics:[]}` ; six plans rendus ;
MP4 960×540, 288 images, audio/vidéo 12 s. Le storyboard contient un external procédural original,
deux personnages, un téléphone paramétrique, un geste et une bulle. Les sons sont des signaux de test.
La CLI compilée (`REV2D_RUNTIME=dist`) valide, construit et rend P004 via le worker JavaScript ;
preuves `dist-validation.json`, `dist-build.json`, `dist-render.json`.

### 3. Cache — OK

```sh
node --import tsx out/demo-phase3/prove-cache.ts
node bin/rev2d.js episode render out/demo-phase3/user/episode --jobs 2 --json
```

`cache-proof.json` : second rendu `rendered:[]`, six cached ; modification d’une clé de P003 →
`rendered:["P003"]`, cinq cached ; restauration exacte ensuite. `user-cache.json` : zéro nouveau
rendu sur 29 plans. Le test « fingerprints a transitive model texture only for the shot using it
and enforces scene frame ownership » vérifie une texture référencée ; le test de cache vérifie
également une vidéo corrompue, le timing imposé et une narration modifiée après build.

### 4. Coupes et repères — OK

Le test « ships a six-shot original example with external, two-character and phone scenes and
cue-aligned cuts » compare les repères aux images `[0,48,96,144,192,240]`. Le test de cache décode
les images 11 et 12 d’une coupe et mesure les couleurs avant/après ; celui des transitions décode
l’image après le fondu et vérifie toutes les positions de coupe et la durée.

```sh
python3 out/demo-phase3/verify-media.py
```

Pour EP011 : 29 coupes, écart prévu maximal de 0,480 image ; écart maximal mesuré sur les PTS
réels du MP4 de 0,496 image par rapport aux starts du plan de production. Ces repères proviennent
des timings existants, associés aux sous-tokens Whisper d’origine ; aucun nouvel alignement n’est
inventé. `@end` conserve la fin réelle du WAV, y compris entre deux limites d’image.

### 5. Assets manquants et demandes — OK

Le test « reports exact missing assets and writes actionable character, prop, background and
native UI requests » construit un storyboard incomplet et attend exactement : background room,
character hero/sitting_phone, prop box, ui progress. Quatre dossiers request.json/prompt.txt sont
écrits. Les caractères connus passent par library request avec leurs références ; les identités
inconnues demandent leurs références. Le test contrôle aussi le refus de build incomplet.

### 6. Vertical — OK

```sh
node bin/rev2d.js episode assemble out/demo-phase3/example-final -o out/demo-phase3/example-vertical.mp4 --size 1080x1920 --json
```

Sortie : 1080×1920, 288 images, audio/vidéo 12 s, quatre `episode-vertical-crop` expliqués par les
éléments excentrés de la fixture. Le test « warns when a focus-aware portrait crop excludes an
important prop » vérifie le code ; le test d’assemblage produit aussi un vrai MP4 1080×1920.

### 7. Revue de tous les plans — OK

```sh
node bin/rev2d.js episode report out/demo-phase3/example-final -o out/demo-phase3/example-report --json
node bin/rev2d.js episode thumbnails out/demo-phase3/example-final -o out/demo-phase3/example-thumbs --at middle --json
node bin/rev2d.js episode report out/demo-phase3/user/episode -o out/demo-phase3/user-report --json
```

Six puis 29 planches, une analyse par plan et index HTML/Markdown/JSON. Les notes sont visibles
dans chaque carte HTML et liées à l’analyse complète. Les external reçoivent des métadonnées et
une note explicite à la place d’une fausse analyse de rig. Le test vérifie les liens d’images,
les fichiers d’analyse et les thumbnails.

### 8. Démo et deux premières minutes — OK pour le montage prototype ; animation artistique partielle

```sh
python3 out/demo-phase3/prepare-user.py
node bin/rev2d.js episode build out/demo-phase3/user/storyboard.json -o out/demo-phase3/user/episode --json
node bin/rev2d.js episode render out/demo-phase3/user/episode --jobs 2 --json
node bin/rev2d.js episode assemble out/demo-phase3/user/episode -o out/demo-phase3/EP011-first120.mp4 --json
```

Sortie : 29 plans P001–P029, 2 880 images à 24 i/s, audio 120 s, vidéo 119,999349 s. Cinq scènes
utilisent des rigs (P001, P006, P010, P022, P023), huit cartes sont animées en calques et seize
illustrations conservent leurs sujets avec un léger mouvement de caméra. Leurs actions de bras,
de téléphone, de bulle ou de casque restent à produire ; ce n’est pas un épisode animé final.
Le gros plan P006 est recadré dans une copie pour conserver le visage dans l’image. Les cartes
ont été revues et leurs textes ajustés pour tenir sans découpe.

P037 est situé à 161,38 s, hors de ce segment. Son fichier validé et son hash sont conservés ;
`media-proof.json` confirme `approvedP037Unchanged:true`. Le README local donne les commandes
avec des chemins neufs pour reconstruire sans écraser les rendus retenus.

## Choix techniques, écarts et limites

- L’import `scene` est un ajout au format du brief, nécessaire pour conserver les plans polis.
  Les durées/fps/offset de narration appartiennent à l’épisode ; le cadrage et le jeu restent auteurs.
- Un external a un `external.json` complet et un `scene.json` de timeline vide : le moteur de scène
  natif ne prétend pas lire une vidéo comme une texture animée.
- Les transitions commencent à la coupe entrante et maintiennent la dernière image sortante.
  Des segments de taille exacte évitent le décalage constaté avec une longue chaîne xfade/concat.
  Les cinq types sont testés, ainsi que l’audio continu et les limites de durée.
- L’alignement pilote une enveloppe de musique ; en son absence, le ducking est un sidechain réel,
  dont l’atténuation dépend du niveau sonore. Le bed boucle s’il est court. AAC peut arrondir le temps
  de fin ; la vérification impose au plus une image d’écart.
- Le recadrage focus est statique par plan, avec trois échantillons de géométrie. Ses alertes sont
  conservatrices ; elles ne prouvent pas la visibilité continue d’une main ni une recomposition.
- Modifier le storyboard/audio/alignement requiert un rebuild. Les entrées de cache incluent le
  manifeste de bibliothèque ; sa modification peut invalider plusieurs plans. Les sorties sont
  hachées et les sources sont relues après rendu.
- ffmpeg/ffprobe restent optionnels pour le dépôt mais nécessaires aux exports vidéo. Les workers
  sont des processus isolés ; `--jobs 2` est le défaut, jusqu’à 16 pour les machines adaptées.
- Les deux avertissements de sourcils de P006 sont hérités de son rig local et visibles dans le
  rapport. Les yeux, poses et accessoires ne sont pas identiques à tous les masters utilisateur.
- Les sorties intermédiaires/échecs de travail restent dans out à titre d’historique. Les preuves
  finales sont nommées explicitement ; aucune image utilisateur, clé ou document privé n’est publié.
- Reste : animer les seize illustrations, adapter les autres actions et revoir l’épisode en mouvement
  avec l’utilisateur avant de le qualifier de final. Pas de looks/lip-sync ajoutés dans cette phase.

## Inventaire des fichiers

- `AGENTS.md` — Consignes de frontières, sources auteurs et revue des épisodes.
- `docs/ARCHITECTURE.md` — Architecture du pipeline épisode et des workers.
- `docs/CLI.md` — Contrats et sorties des sept commandes episode.
- `docs/EPISODE.md` — Guide agent complet, format, cache, audio, vertical et limites.
- `docs/MCP.md` — Table des sept outils épisode et effets de fichiers.
- `docs/SPEC.md` — Lien entre storyboard et scènes sans modifier le modèle.
- `examples/README.md` — Découverte de l’exemple original à six plans.
- `examples/episodes/demo/README.md` — Provenance des fixtures et régénération du pack.
- `examples/episodes/demo/external.mp4` — Clip procédural original explicitement déclaré.
- `examples/episodes/demo/music.wav` — Signal musical original de démonstration.
- `examples/episodes/demo/storyboard.json` — Six plans, personnages, UI, geste, bulle et transitions.
- `examples/episodes/demo/voice.alignment.json` — Repères de test originaux aux coupes de deux secondes.
- `examples/episodes/demo/voice.wav` — Signal de narration original avec silences alignés.
- `package.json` — Entrée publique pure rev2d/episode, aucune dépendance ajoutée.
- `scripts/build-episode-example.ts` — Point d’entrée de génération du pack original.
- `scripts/examples/episode-demo.ts` — Builder de storyboard, audio et clip procédural.
- `src/cli/commands/episode.ts` — Sept commandes avec JSON, progression et annulation.
- `src/cli/commands/index.ts` — Enregistrement du groupe episode dans l’aide.
- `src/cli/commands/reference.ts` — Documentation episode disponible hors ligne.
- `src/episode/__tests__/episode.test.ts` — Tests purs des repères, arrondis, assets, recadrage et ducking.
- `src/episode/compile.ts` — Planification des assets et traduction explicite en scènes.
- `src/episode/index.ts` — API pure exportée.
- `src/episode/schema.ts` — Schéma versionné, types et diagnostics du storyboard.
- `src/episode/timeline.ts` — Coupes partagées, transitions quantifiées et fenêtres de parole.
- `src/index.ts` — Export Node des nouvelles API.
- `src/mcp/__tests__/server.test.ts` — Découverte des sept nouveaux outils, total 44.
- `src/mcp/guide.ts` — Parcours agent incluant le pipeline épisode.
- `src/mcp/server.ts` — Enregistrement des outils épisode.
- `src/mcp/tools/docs.ts` — Documentation episode et ressource hors ligne.
- `src/mcp/tools/episode.ts` — Adaptateurs MCP utilisant les mêmes IO que la CLI.
- `src/node/episode-assemble.ts` — Transitions par segments exacts, mix audio et crops focus.
- `src/node/episode-media.ts` — Processus ffmpeg/ffprobe bornés, sans shell, publication atomique.
- `src/node/episode-render.ts` — Cache des ressources transitives et des sorties, pool de workers.
- `src/node/episode-report.ts` — Planches, analyses, notes et index HTML/Markdown/JSON.
- `src/node/episode-worker.ts` — Rendu isolé et normalisation des clips.
- `src/node/episode.ts` — Validation, demandes, import de scènes auteurs et builds gérés.
- `src/node/scene.ts` — Validation d’un document virtuel sans fichier de scratch près de la source.
- `src/scene/schema.ts` — Réutilisation additive des champs communs de calque.
- `test/docs-commands.test.ts` — Vérification des commandes du nouveau guide.
- `test/docs-links.test.ts` — Vérification des liens du guide et du README de l’exemple.
- `test/episode-browser.test.ts` — Bundle navigateur de l’API pure sans shim Node.
- `test/episode-tools.test.ts` — Exécution réelle des sept outils MCP et codes CLI.
- `test/episode.test.ts` — Intégration, cache, textures, coupes décodées, transitions, vertical et rapports.
- `reports/PHASE-3.md` — Présent rapport, critères, preuves et limites.
- `reports/OBJECTIFS.md` — Tableau de progression actualisé.
- `reports/PHASE-2.md` — Lien vers le suivi courant de phase 3.
