# Phase 1 — scènes, caméra, narration et export vidéo

**Statut : phase 1 livrée et vérifiée techniquement, suite générale entièrement verte.** Les limites artistiques et de mémoire des scènes chargées restent explicites ci-dessous.
Ce travail ne livre pas le jeu de bras/mains de phase 2 ni l’assemblage d’épisodes de phase 3.

## Révisions et périmètre

- Départ : `911ea02ee1409bcf0d47fa08c6105faf26d3f8cf`, phase 0 et corrections amont, suite verte.
- Code livré et vérifié : `01d8e9322fd77fe11da3637d9174f098825290e7`.
- Branche : `phase-1-scene` ; base de PR : `phase-0-library` du fork utilisateur.
- Commits : `f1ad26b` (workspace raster), `9265457` (moteur pur), `b9c6287` (IO, vidéo et exemple), `01d8e93` (CLI, MCP et documentation).
- Environnement : macOS x86_64, Node v24.21.0, npm 11.19.0, ffmpeg et ffprobe locaux. Aucune dépendance npm ajoutée ; aucun appel réseau ou générateur d’images dans le moteur.
- Le brief, les décors/personnages utilisateur, la narration et les démonstrations EP011 restent locaux sous `out/`. Les seuls PNG/WAV ajoutés au dépôt sont les fixtures originales générées par les scripts.

## Résultats des vérifications

Commandes finales exécutées successivement :

```sh
/usr/bin/time -l node --import tsx scripts/scene-memory.ts out/demo-phase1/memory-final 2000
npm run typecheck
npm run build
npm test
```

Les journaux complets sont locaux dans `out/demo-phase1/`. Le typecheck est terminé avec le code 0 :

```text
> rev2d@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
```

Le build est terminé avec le code 0 et inclut bien le build éditeur :

```text
> rev2d@0.1.0 build
> tsc -p tsconfig.build.json && npm run editor:build

> rev2d@0.1.0 editor:build
> vite build --config editor/vite.config.ts

✓ 451 modules transformed.
✓ built in 896ms
```

Suite ciblée, avant la suite complète :

```text
 Test Files  12 passed (12)
      Tests  280 passed (280)
   Start at  23:26:15
   Duration  7.86s (tests 44%, transform 43%, import 12%)
```

Résumé brut de la suite complète, code de sortie 0 :

```text
 Test Files  154 passed (154)
      Tests  2769 passed | 2 skipped (2771)
   Start at  23:29:42
   Duration  386.73s (tests 86%, import 10%, transform 4%)
```

Aucun échec nouveau ni restant. Les deux cas ignorés le sont déjà dans la phase précédente ; aucun seuil ni test n’a été désactivé pour obtenir ce résultat. Les retouches de documentation suivantes ne changent pas le code vérifié ; leurs contrôles dédiés sont relancés après la suite générale.

Contrôle documentaire après les dernières précisions de texte, code de sortie 0 :

```text
 Test Files  4 passed (4)
      Tests  73 passed (73)
   Start at  23:37:54
   Duration  6.60s (tests 49%, transform 41%, import 10%)
```

## Acceptation, critère par critère

| Nº | État | Preuve reproductible |
| --- | --- | --- |
| 1 | OK | Typecheck et build 0 ; 280 tests ciblés réussis ; suite générale : 2 769 réussis, 2 ignorés, 0 échec. Résumé brut ci-dessus. |
| 2 | OK | `node bin/rev2d.js scene validate examples/scenes/room-demo/scene.json --json` → `{ "ok": true, "diagnostics": [] }`. Même résultat pour `portrait.json`. `test/scene.test.ts` et `src/scene/__tests__/scene.test.ts` vérifient les fichiers/références/modèles/audio invalides, repères absents, ids dupliqués, ancres, cycles et cibles avec codes/pointeurs/hints. |
| 3 | OK | Les trois commandes de rendu ci-dessous et `node out/demo-phase1/verify-media.mjs` produisent/vérifient H.264, yuv420p, 24/1, AAC, tailles demandées et durée 6 s pour vidéo et audio. |
| 4 | OK | `test/scene.test.ts` : « PNG export is byte deterministic and never modifies a source model » compare les 12 PNG de deux exports par SHA-256 et vérifie le hash du modèle source. |
| 5 | OK | `src/scene/__tests__/scene.test.ts` : « applies the documented 1 / 0.5 / 0 parallax pan and zoom formula » mesure exactement 200 / 100 / 0 px ; vérifie aussi zoom et rotation. |
| 6 | OK | `scene info` et le test « loads both shipped scene formats with zero errors and warnings and exact narration cues » vérifient 2,5 s, 3,2 s et 4 s. Les tests d’alignement couvrent ElevenLabs normalisé, mots, accents, casse, répétitions, offset, fins de mots, suffixes et erreur avec suggestion. |
| 7 | OK | Test « overshoots and settles pop while fade stays monotone and entries stay hidden » : dépassement >1, retour exact à 1, fade monotone, invisibilité avant l’entrée ; tous les types de sortie finissent invisibles. |
| 8 | OK | Test « switches poses on the exact frame and keeps parameter animation on the scene clock » : à 23/24 s pose assise, à 1 s pose debout, même paramètre animé à 0,5 puis 25/48. La composition utilise la source de cet état évalué. Dissolve testé séparément. |
| 9 | OK | Test « keeps each pose physics player continuous through pose changes » : chaque échantillon de 0 à 2 s est identique à un player de référence ; la sortie physique est effectivement non nulle et continue au changement. |
| 10 | OK | Test « detects reveal intervals and their maximum overflow at the requested fps » : intervalle `[0.1,2]`, maximum 190 px ; depth 0 ne produit pas de débordement. Les autres avertissements de cadrage/chevauchement/vitesse sont aussi exercés. |
| 11 | OK sur le benchmark défini | Test « missing ffmpeg has a stable diagnostic and CLI exit 1 while PNG still works » ; benchmark final 2 000 images 1920×1080 : RSS Node maximal 350 650 368 octets, sous la limite 524 288 000. Mesure système et réserve pour les scènes complexes ci-dessous. |
| 12 | OK pour les démos de composition ; limites artistiques explicites | `out/demo-phase1/` contient paysage, portrait et 720p, leurs planches et 3 études EP011 : P001 (un personnage), P010 (deux personnages), P060 (téléphone avec écran vectoriel). Une variante P060 anime la barre. Les actions articulées et la fidélité pixel par pixel ne sont pas livrées par cette phase. |

Commandes ciblées exactes :

```sh
node node_modules/vitest/vitest.mjs run --project node src/scene/__tests__/scene.test.ts src/render/__tests__/workspace.test.ts src/render/__tests__/raster.test.ts test/scene.test.ts test/scene-browser.test.ts test/scene-tools.test.ts test/cli.test.ts src/mcp/__tests__/server.test.ts test/docs-commands.test.ts test/docs-links.test.ts test/docs-avatar.test.ts test/docs-recipes.test.ts
```

Le test navigateur bundle tout `src/scene/index.ts` sans shims Node. Les tests MCP invoquent les cinq nouveaux outils avec de vrais fichiers et des PNG inline, vérifient leurs descriptions <2 048 caractères et les diagnostics d’erreur. Les sept commandes CLI sont exercées, dont la séparation progression stderr / JSON stdout. Le workspace raster est comparé au rendu sans cache pour textures, masques, transparence, changements de taille et pixels modifiés après invalidation ; les images déjà rendues restent indépendantes.

## Démonstrations et métadonnées vidéo

```sh
node bin/rev2d.js scene render examples/scenes/room-demo/scene.json -o out/demo-phase1/demo-landscape.mp4 --json
node bin/rev2d.js scene render examples/scenes/room-demo/portrait.json -o out/demo-phase1/demo-portrait.mp4 --json
node bin/rev2d.js scene render examples/scenes/room-demo/scene.json -o out/demo-phase1/demo-720.mp4 --scale 0.6666666667 --json
node out/demo-phase1/verify-media.mjs
```

`verify-media.mjs` lance `ffprobe -v error -show_entries stream=codec_name,codec_type,pix_fmt,width,height,r_frame_rate,duration,nb_frames -show_entries format=duration -of json <fichier>` et vérifie les valeurs. Les résultats détaillés sont dans `out/demo-phase1/media-verification.json`.

| Vidéo | Taille | Images à 24 i/s | Durée vidéo | Durée AAC |
| --- | --- | --- | --- | --- |
| `demo-landscape.mp4` | 1920×1080 | 144 | 6,000000 s | 6,000000 s |
| `demo-portrait.mp4` | 1080×1920 | 144 | 6,000000 s | 6,000000 s |
| `demo-720.mp4` | 1280×720 | 144 | 6,000000 s | 6,000000 s |
| `user/P001.mp4` | 1376×768 | 68 | 2,833333 s | 2,833000 s |
| `user/P010-cached.mp4` | 1376×768 | 169 | 7,041667 s | 7,042000 s |
| `user/P060.mp4` | 1376×768 | 205 | 8,541667 s | 8,542000 s |
| `user/P060-ui-animation.mp4` | 1376×768 | 72 | 3,000000 s | 3,000000 s |

Tous : `h264`, `yuv420p`, `24/1`, audio `aac`. Résultat du vérificateur : `ok: true`, `files: 7`. Les durées sont dans la tolérance d’une image. Le plan P060 de référence conserve sa barre stable ; la variante animée est une preuve d’interface, pas un changement narratif silencieux.

Le décor canonique du téléphone sert de fond réutilisable ; son écran est recouvert et redessiné par un modèle vectoriel en calque, avec un paramètre `Progress` indépendant. Le téléphone n’est pas un clip rejoué. Les plans larges utilisent le salon vide et les avatars séparés de la bibliothèque de phase 0. La narration est prélevée aux positions 0 ; 30,62 ; 294,02 s du plan EP011 ; aucun alignement de mots utilisateur n’a été fabriqué. L’exemple public possède son propre alignement synthétique et un signal WAV de référence, pas une fausse voix.

Les planches synthétiques paysage et portrait ont été inspectées, ainsi que les images de contrôle utilisateur. Le cadre portrait est dédié. La revalidation de la bibliothèque utilisateur après rendu donne `{ "ok": true, "diagnostics": [] }`, sans modification des empreintes des sources/rigs.

## Mémoire et limites de performance

Benchmark final exact :

```text
width: 1920, height: 1080, fps: 24, frames: 2000
duration: 83.33333333333333
peakRssBytes: 350535680
processMaxRssBytes: 350650368
limitBytes: 524288000

       28.51 real       101.42 user        13.41 sys
           418594816  maximum resident set size
```

La mesure Node est d’environ 334,4 Mio ; le maximum relevé par `time -l` est d’environ 399,2 Mio, tous deux sous 500 Mio. Ce test utilise une scène simple : il prouve le flux de 2 000 images Full HD, pas une borne universelle pour des bibliothèques arbitrairement grandes.

Le cas utilisateur à deux avatars est plus chargé : RSS observé 574 038 016 octets avant cache, 525 058 048 après cache (environ 500,7 Mio). Son export passe d’environ 4,7 à 6,2 images/s sur cette machine. La marge mémoire reste donc faible sur ce cas ; une scène avec davantage de textures peut dépasser ce volume. Le rendu logiciel n’est pas présenté comme temps réel.

Les deux MP4 P010 ont exactement le même SHA-256, avant et après cache :

```text
10ce59735ff485c9c48b02c378a905abc0858c5002802bbb2c819add4d6eed55
```

Le workspace ne retient pas la séquence de frames. La conversion des textures n’est réutilisée qu’avec l’option explicite de sources immuables ; `resetTextures()` permet l’invalidation si un client édite leurs pixels.

## Écarts et suite

- `draw-on` est une révélation géométrique progressive verticale, pas un traceur automatique de contours au stylo.
- Les limites de taille utilisent un grand côté maximal de 3 840 et une aire maximale de 3 840×2 160 pour autoriser aussi le portrait 1 080×1 920.
- GIF est un flux à palette RGB8 fixe ; le MP4 reste la sortie de production.
- Les avertissements de chevauchement utilisent des rectangles source conservateurs, avec transparence comprise. Ils nécessitent une revue visuelle.
- P001 utilise encore le salon de jour disponible dans la bibliothèque, contrairement à l’éclairage du soir de son image maître. Les poses disponibles sont de face ; elles ne reproduisent pas exactement les vues trois-quarts. Les fixtures synthétiques servent aux mesures, pas à une approbation artistique.
- C1 hoche la tête et change de regard ; les doigts ne défilent pas encore sur le téléphone et C2 ne tapote pas encore le calendrier. Bras, mains et gestes attendent la phase 2. Pas de lip-sync ni d’épisode assemblé.
- Le récapitulatif et les commandes locales de régénération se trouvent dans `out/demo-phase1/README.md`.

## Fichiers créés ou modifiés

L’inventaire ci-dessous distingue les modules, leur intégration et les artefacts synthétiques générés. Les fichiers utilisateur sous `out/` n’y figurent pas.

| Fichier | Rôle |
| --- | --- |
| `AGENTS.md` | Documentation et guide de développement/workflow mis à jour. |
| `README.md` | Documentation et guide de développement/workflow mis à jour. |
| `docs/ARCHITECTURE.md` | Documentation et guide de développement/workflow mis à jour. |
| `docs/AVATAR.md` | Documentation et guide de développement/workflow mis à jour. |
| `docs/CLI.md` | Documentation et guide de développement/workflow mis à jour. |
| `docs/MCP.md` | Documentation et guide de développement/workflow mis à jour. |
| `docs/OPS.md` | Documentation et guide de développement/workflow mis à jour. |
| `docs/SCENE.md` | Documentation et guide de développement/workflow mis à jour. |
| `docs/SPEC.md` | Documentation et guide de développement/workflow mis à jour. |
| `examples/README.md` | Documentation et guide de développement/workflow mis à jour. |
| `examples/scenes/room-demo/library/backgrounds/room/import.json` | Métadonnées de détourage/import de l’asset synthétique. |
| `examples/scenes/room-demo/library/backgrounds/room/source.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/library/bubbles/thought/import.json` | Métadonnées de détourage/import de l’asset synthétique. |
| `examples/scenes/room-demo/library/bubbles/thought/source.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/avatar.json` | Landmarks auteurs de la pose synthétique. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/figure_sitting_phone.r2d.json` | Modèle synthétique construit ou interface vectorielle paramétrée. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/import.json` | Métadonnées de détourage/import de l’asset synthétique. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/library-build.json` | Empreintes de provenance de la pose synthétique construite. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/source.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/base.png` | Texture synthétique générée : base.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeL_ball.png` | Texture synthétique générée : eyeL_ball.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeL_crease.png` | Texture synthétique générée : eyeL_crease.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeL_front.png` | Texture synthétique générée : eyeL_front.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeL_lower.png` | Texture synthétique générée : eyeL_lower.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeL_upper.png` | Texture synthétique générée : eyeL_upper.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeR_ball.png` | Texture synthétique générée : eyeR_ball.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeR_crease.png` | Texture synthétique générée : eyeR_crease.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeR_front.png` | Texture synthétique générée : eyeR_front.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeR_lower.png` | Texture synthétique générée : eyeR_lower.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/eyeR_upper.png` | Texture synthétique générée : eyeR_upper.png. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/layers.json` | Métadonnées des calques synthétiques construits. |
| `examples/scenes/room-demo/library/characters/figure/sitting_phone/textures/mouth.png` | Texture synthétique générée : mouth.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/avatar.json` | Landmarks auteurs de la pose synthétique. |
| `examples/scenes/room-demo/library/characters/figure/standing/figure_standing.r2d.json` | Modèle synthétique construit ou interface vectorielle paramétrée. |
| `examples/scenes/room-demo/library/characters/figure/standing/import.json` | Métadonnées de détourage/import de l’asset synthétique. |
| `examples/scenes/room-demo/library/characters/figure/standing/library-build.json` | Empreintes de provenance de la pose synthétique construite. |
| `examples/scenes/room-demo/library/characters/figure/standing/source.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/base.png` | Texture synthétique générée : base.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeL_ball.png` | Texture synthétique générée : eyeL_ball.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeL_crease.png` | Texture synthétique générée : eyeL_crease.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeL_front.png` | Texture synthétique générée : eyeL_front.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeL_lower.png` | Texture synthétique générée : eyeL_lower.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeL_upper.png` | Texture synthétique générée : eyeL_upper.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeR_ball.png` | Texture synthétique générée : eyeR_ball.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeR_crease.png` | Texture synthétique générée : eyeR_crease.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeR_front.png` | Texture synthétique générée : eyeR_front.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeR_lower.png` | Texture synthétique générée : eyeR_lower.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/eyeR_upper.png` | Texture synthétique générée : eyeR_upper.png. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/layers.json` | Métadonnées des calques synthétiques construits. |
| `examples/scenes/room-demo/library/characters/figure/standing/textures/mouth.png` | Texture synthétique générée : mouth.png. |
| `examples/scenes/room-demo/library/library.json` | Manifest de la bibliothèque synthétique. |
| `examples/scenes/room-demo/library/props/box/import.json` | Métadonnées de détourage/import de l’asset synthétique. |
| `examples/scenes/room-demo/library/props/box/source.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/library/ui/phone.r2d.json` | Modèle synthétique construit ou interface vectorielle paramétrée. |
| `examples/scenes/room-demo/portrait.json` | Document scène synthétique paysage ou portrait. |
| `examples/scenes/room-demo/scene.json` | Document scène synthétique paysage ou portrait. |
| `examples/scenes/room-demo/sources/box.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/sources/room.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/sources/sitting_phone.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/sources/standing.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/sources/thought.png` | Image synthétique originale générée par les builders. |
| `examples/scenes/room-demo/voice.alignment.json` | Alignement de mots synthétique, écrit explicitement. |
| `examples/scenes/room-demo/voice.wav` | Signal PCM synthétique de référence temporelle. |
| `llms.txt` | Documentation et guide de développement/workflow mis à jour. |
| `scripts/build-scenes.ts` | Construction reproductible des assets et scènes synthétiques. |
| `scripts/examples/scene-assets.ts` | Construction reproductible des assets et scènes synthétiques. |
| `scripts/scene-memory.ts` | Benchmark reproductible de 2 000 images Full HD. |
| `src/cli/commands/index.ts` | Enregistrement, exports, aide et documentation offline des nouvelles API. |
| `src/cli/commands/reference.ts` | Enregistrement, exports, aide et documentation offline des nouvelles API. |
| `src/cli/commands/scene.ts` | Sept commandes CLI de scène, JSON et progression stderr. |
| `src/index.ts` | Enregistrement, exports, aide et documentation offline des nouvelles API. |
| `src/mcp/__tests__/server.test.ts` | Tests automatisés du moteur, des adaptateurs ou de leur documentation. |
| `src/mcp/guide.ts` | Enregistrement, exports, aide et documentation offline des nouvelles API. |
| `src/mcp/server.ts` | Enregistrement, exports, aide et documentation offline des nouvelles API. |
| `src/mcp/tools/docs.ts` | Enregistrement, exports, aide et documentation offline des nouvelles API. |
| `src/mcp/tools/scene.ts` | Cinq outils MCP de scène, images inline et diagnostics. |
| `src/node/scene.ts` | Chargement/cache des fichiers et modèles, résolution des assets et analyse partagée. |
| `src/node/video.ts` | Export en flux, ffmpeg sans shell, audio, annulation et publication sans écrasement. |
| `src/render/__tests__/workspace.test.ts` | Régression pixels/masques/transparence/alias avec réutilisation de buffers. |
| `src/render/browser.ts` | Export navigateur du workspace. |
| `src/render/raster.ts` | Branchement localisé du workspace dans le rasteriseur existant. |
| `src/render/workspace.ts` | Buffer réutilisable et cache opt-in des textures immuables. |
| `src/scene/__tests__/scene.test.ts` | Tests automatisés du moteur, des adaptateurs ou de leur documentation. |
| `src/scene/alignment.ts` | Alignement narration et résolution des temps symboliques. |
| `src/scene/analyze.ts` | Analyse échantillonnée du cadrage et des chevauchements. |
| `src/scene/camera.ts` | Caméra, parallaxe, bruit seedé et ressort critique. |
| `src/scene/evaluate.ts` | Placement, poses, paramètres et players de physique par calque. |
| `src/scene/index.ts` | Exports publics du module. |
| `src/scene/render.ts` | Composition géométrique, masques, frames et planches. |
| `src/scene/schema.ts` | Contrat zod et diagnostics structurés de scène. |
| `src/scene/timing.ts` | Interpolation numérique et apparitions. |
| `src/scene/types.ts` | Contrats des sources et états évalués. |
| `src/scene/validate.ts` | Références, ancres, cycles, animations, paramètres et cibles. |
| `test/docs-commands.test.ts` | Tests automatisés du moteur, des adaptateurs ou de leur documentation. |
| `test/docs-links.test.ts` | Tests automatisés du moteur, des adaptateurs ou de leur documentation. |
| `test/scene-browser.test.ts` | Tests automatisés du moteur, des adaptateurs ou de leur documentation. |
| `test/scene-tools.test.ts` | Tests automatisés du moteur, des adaptateurs ou de leur documentation. |
| `test/scene.test.ts` | Tests automatisés du moteur, des adaptateurs ou de leur documentation. |
| `reports/PHASE-1.md` | Rapport d’acceptation, sorties brutes, inventaire et limites. |
| `reports/OBJECTIFS.md` | État des phases et prochaine étape. |

