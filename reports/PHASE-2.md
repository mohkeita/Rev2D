# Phase 2 — jeu d’acteur, bras et expressions

**Statut : phase 2 implémentée et vérifiée techniquement ; limites artistiques explicites.**

**Version P037 courante :** `out/demo-phase2/P037-reference-rhythm/P037.mp4` ; aperçu agrandi des six secondes : `P037-detail.mp4` dans le même dossier. Les autres versions P037 ci-dessous sont des étapes de revue conservées.
Les corrections de bras répondent au défaut visuel signalé : manches étirées, raccords au poignet et morceaux de l’ancienne main. Les gestes numériques restent à adapter artistiquement aux personnages et aux contacts de chaque plan. À cette livraison, la phase 3 n’était pas commencée ; son suivi courant est désormais dans [PHASE-3.md](PHASE-3.md).

## Révisions et périmètre

- Départ : `d6511b31eed232153b2dd98e8972e7244fa09833`, phase 1.
- Branche : `phase-2-acting` ; base de PR : `phase-1-scene` du fork utilisateur.
- Arrivée du code vérifié : `8ca6f0971b8f1765f2afeeac9b0a7f3724c70bb9` ; ce rapport et le tableau des objectifs sont livrés dans le commit documentaire suivant.
- Commits : `85b2cf3` (rig/avatar et raccords), `311f859` (jeu d’acteur pur et op act), `e634be2` (scènes, CLI/MCP et IO), `8ca6f09` (exemple original et contrôle du catalogue).
- macOS x86_64, Node v24.21.0, npm 11.19.0, ffmpeg/ffprobe locaux.
- Aucune dépendance npm ajoutée, aucun service réseau ou modèle vidéo utilisé. Les modules purs restent indépendants de Node ; les entrées/sorties partagées sont dans `src/node`.
- Les images, voix, modèles et vidéos EP011 restent dans `out/`, ignoré par Git. L’exemple public est entièrement dessiné par les builders TypeScript originaux du dépôt.

La livraison ajoute les landmarks des bras/jambes, le cadrage complet, les découpes, les os et contrôles de bras, 21 variants dessinés (30 au total), 16 gestes, 11 expressions et un idle seedé. Elle ajoute l’opération `act`, quatre commandes CLI et trois outils MCP. Les scènes génèrent les animations en mémoire sans réécrire les modèles source.

## Vérifications finales

Commandes exécutées, après les exports et avant toute autre charge Chrome :

```sh
node --import tsx out/demo-phase2/prepare-user.ts out/demo-phase2/user-release
node --import tsx out/demo-phase2/render-release.ts
node --import tsx out/demo-phase2/verify-release.ts
npm run typecheck
npm run build
npm test
```

Les journaux sont locaux : `out/demo-phase2/final-typecheck.log`, `final-build.log`, `final-tests.log`, `final-review.log`. Les métadonnées vidéo sont dans `final-review/media.json`.

Typecheck, code 0 :

```text
> rev2d@0.1.0 typecheck
> tsc --noEmit -p tsconfig.json
```

Extraits bruts du build, code 0, éditeur inclus :

```text
> rev2d@0.1.0 build
> tsc -p tsconfig.build.json && npm run editor:build

> rev2d@0.1.0 editor:build
> vite build --config editor/vite.config.ts

✓ 455 modules transformed.
✓ built in 1.07s
```

Résumé brut de `npm test`, code de sortie 0 :

```text
 Test Files  160 passed (160)
      Tests  2841 passed | 2 skipped (2843)
   Start at  09:09:48
   Duration  436.12s (tests 87%, import 10%, transform 3%)
```

Les 72 tests ajoutés depuis la phase 1 passent. Le total de deux cas ignorés est identique à celui de la phase 1 ; aucun nouveau test ne contient de skip. Les tests Chrome ont bien été exécutés. Un contrôle ciblé verbose confirme notamment le skip de l’alias loopback `127.0.0.2`, indisponible sur ce macOS ; le journal compact de la suite complète ne détaille pas les noms des deux cas. Après une simple mise en forme du catalogue et d’un export de fixture, les trois fichiers ciblés (`act`, package, API serveur) passent : 49 réussis, 1 ignoré, 5,47 s ; journal `final-details.log`.

Un premier passage d’intégration avait 13 échecs : anciennes attentes de catalogue/groupes, documentation, sélection `variants --all` sur buste et délai d’analyse de l’exemple sous charge. Les attentes et la documentation ont été mises à jour, `--all` ne demande désormais que les variants compatibles avec le modèle, et l’analyse complète conserve ses 24 échantillons/s avec un délai de 120 s. Aucun test n’est supprimé. Le journal initial est conservé sous `tests-before-final-corrections.log`.

## Acceptation

| Nº | Statut | Commande ou test et résultat |
| --- | --- | --- |
| 1 | OK | Typecheck et build : 0. `npm test` : 160 fichiers, 2 841 réussis, 2 ignorés, 0 échec ; documentation, CLI/MCP et éditeur inclus. |
| 2 | OK | `test/avatar-arms.test.ts`, « preserves rest illustration within two channel levels on at least 99% of pixels ». `verify-release.ts` mesure 436 pixels hors tolérance sur 172 800 : **99,7477 %** dans la tolérance ±2. |
| 3 | OK | Même fichier, « places the wrist within three pixels of analytic shoulder rotation ». À `ArmRA=45`, erreur mesurée **4,27×10⁻¹⁴ px**, donc <3 px. |
| 4 | OK | Même fichier, « has no folded cells at every parameter extreme and the head/body combinations ». Les poses croisent chaque nouveau paramètre avec `AngleX=±30` et `BodyAngleX=±10`. `test/acting-example.test.ts` vérifie aussi le modèle avec les 21 variants importés. Les deux avatars utilisateur construits ont `folds: []`. |
| 5 | OK avec interprétation géométrique précisée | « leaves no alpha hole in the exposed torso after raising either arm » teste chaque pixel du torse exposé : alpha 255. L’ancienne position du bras doit devenir transparente à l’extérieur du torse ; conserver toute la silhouette d’origine y créerait un bras fantôme. Ce n’est donc pas un test de conservation de l’ancienne silhouette entière. |
| 6 | OK | `src/ops/__tests__/act.test.ts` et `test/gestures.test.ts` vérifient anticipation opposée, dépassement, stabilisation, maintien/retour et rejet des valeurs hors plage. |
| 7 | OK technique ; revue artistique limitée | `test/acting-example.test.ts` analyse les 28 animations publiques à 24 fps sans note et valide le modèle sans avertissement. `verify-release.ts` écrit une planche par animation dans `final-review/`, `analysis.json` donne 28 animations et `notes: []`. Les planches des gestes de la démo et des trois plans utilisateur ont été examinées ; l’absence de note ne prouve pas un contact main/objet exact. |
| 8 | OK | `test/gestures.test.ts`, tests de l’idle : groupes de clignements seedés sur 60 s, intervalles de 2–6 s, non périodiques, identité pour une même seed et différence entre personnages/plans. Les doubles clignements sont deux impulsions du même groupe. |
| 9 | OK | `test/acting-io.test.ts`, « loading, cue resolution and rendering generated scene acting leave the model file hash unchanged » : SHA-256 identique avant/après chargement, résolution du repère et rendu. Le test pur vérifie aussi les objets source. |
| 10 | OK pour les exports ; fidélité exacte non atteinte | Démo originale de 12 s + planches `voila`, `point_right`, `scratch_head`, `expression_shocked`, `expression_thinking`. Extraits utilisateur P010, P037, P006 rendus à nouveau depuis les assets, avec narration. Limites visuelles ci-dessous. |

La suite ajoute aussi un contrôle des distances entre sommets des manches et avant-bras à plusieurs angles du coude, jusqu’à ±150°. Cela empêche de réintroduire l’étirement visible malgré des maillages sans plis.

## Démonstrations et correction des bras

Le premier lot d’exports vérifié est conservé sous les chemins suivants. Pour P037, utiliser la version courante indiquée en tête du rapport :

- `out/demo-phase2/acting-demo-final.mp4` : exemple synthétique original, 960×540, 24 fps, 288 images, 12 s.
- `out/demo-phase2/user-release/P010.mp4` : C2 pointe le calendrier, C1 assis ; 1376×768, 169 images, 7,041667 s.
- `out/demo-phase2/user-release/P037.mp4` : C1 lève la main vers la tête ; 1376×768, 144 images, 6 s.
- `out/demo-phase2/user-release/P006.mp4` : surprise en gros plan ; 1376×768, 79 images, 3,291667 s.

`verify-release.ts` appelle ffprobe et rejette les codecs, cadence ou tailles inattendus. Les quatre vidéos sont H.264/yuv420p à 24/1 ; les trois extraits utilisateur ont une piste AAC de même durée à l’arrondi d’une image près. Les durées sont quantifiées au nombre entier d’images. Aucun clip préexistant n’est rejoué.

Le premier bras utilisait un maillage continu à trois rangées : absence de plis géométriques mais manche visiblement déformée. Le correctif conserve deux sections rigides skinnées sur leurs os respectifs, un raccord de coude et une extension de poignet de la couleur/épaisseur échantillonnées. La manche supérieure passe derrière le torse ; avant-bras et gant respectent `front`. Les contours de gants incluent les pixels d’anticrénelage pour retirer l’ancienne main.

Les landmarks de démonstration ont été repris manuellement. Pour C2, une découpe UV spécifique élimine un fragment de manche sans embarquer le bord du torse. Deux formes de mains sont dessinées par des pièces vectorielles natives (poing de C1, index de C2), avec des raccords locaux du contour du torse. Ces ajustements restent dans les scripts locaux ; ils ne sont pas présentés comme un détourage ou une retouche automatique universels.

## Écarts et limites

- **Pli doux au coude** : remplacé par deux sections rigides et un raccord couvert. Ce choix protège les manches et les avant-bras fins du style demandé. Il ne simule pas la déformation d’un vêtement volumineux à tous les angles.
- **Os sous root warp** : le format v1 autorise les os sous des os, sans parent warp. Le root d’épaule suit donc les mêmes champs de position/rotation du corps par bindings ; le format du moteur n’a pas changé.
- **Superposition** : le haut de manche reste derrière le torse pour cacher la racine ; `front` pilote la profondeur de l’avant-bras et de la main. Les poses bras croisés et les contacts précis exigent un ordre de calques et des dessins appropriés.
- Les gestes sont des cibles normalisées à deux segments, sans détection de collision ni solveur de contact avec le décor. Le placement du calendrier est ajusté dans la démo ; le doigt ne suit pas automatiquement une case arbitraire.
- P037 reste une approximation du grattement de tête : la main approche le front/la tempe ; le contact exact et la forme du gant peuvent être améliorés. La fidélité exacte à la vidéo de référence n’est pas acquise.
- Les sourcils de C1 ne sont pas isolés : P037 et P006 conservent chacun deux avertissements explicites `gesture-missing-param` pour `BrowLY`/`BrowRY`. P010 n’a pas de diagnostic. Les bouches analytiques de secours approchent le shading ; des variants dessinés sont préférables.
- Les démos n’ont pas tous les variants de mains du personnage utilisateur : l’exemple original prouve le catalogue complet ; les deux formes ajoutées localement servent les deux actions sélectionnées.
- Les vues de face, le salon de jour et le calendrier vectoriel ne reproduisent pas tous les angles et éclairages des images maîtres (notamment P006 au soir). Il ne s’agit pas encore des 81 plans EP011 ni d’un épisode assemblé.
- RSS Node maximal rapporté par export dans ce lot : P037 521 682 944 octets, P010 706 396 160, P006 721 522 688, synthétique 498 216 960. Les avatars à textures multiples peuvent dépasser 500 Mio ; aucune borne universelle ou performance temps réel n’est revendiquée.
- Le nombre de tests ignorés est identique à la phase précédente ; aucun nouveau test n’est volontairement ignoré. Le journal compact ne permet pas d’attribuer rétrospectivement chacun des deux skips de ce passage.
- Les phases 3/4, les dessins supplémentaires et la fidélité artistique complète restent à faire. La phase 5 nécessite une demande explicite.

## Retouche du contact de P037 après livraison technique

Le nouvel extrait local retenu pour ce geste est `out/demo-phase2/user-contact-refined/P037.mp4`. Les vidéos `user-release` ci-dessus restent les preuves du premier lot ; ce complément affine uniquement P037.

```sh
node --import tsx out/demo-phase2/prepare-contact.ts
node --import tsx out/demo-phase2/render-contact.ts
```

Le premier script utilise les assets existants de `user-release` et écrit dans un nouveau dossier. Il choisit un repère auteur sur la tempe et un point du contour du poing. Un solveur à deux segments produit des pistes numériques de scène pour l’épaule, le coude et le poignet à 24 fps. Il suit le mouvement de la tête, ajoute un petit grattement à amplitude progressive, garde l’œil dégagé et ramène le bras au repos. Une variante hors de portée a été rejetée avant la sélection finale. Ces pistes sont propres à ce plan ; elles n’ajoutent pas de solveur universel de contact au moteur.

Le contrôle final mesure 69 images pendant le maintien : écart maximal **0,0023891 pixel modèle** entre le point du gant et sa cible animée. Il mesure la cohérence de deux repères auteurs, pas une détection automatique de la surface des cheveux. Le SHA-256 du modèle source reste identique avant/après préparation et export : `83a99694505f9e0a6a47337a1887e307adaead6df23f7b162e08a8f4304d729f`.

`contact-report.json` et `export-report.json` accompagnent l’extrait. ffprobe confirme 1376×768, H.264/yuv420p, 24/1, 144 images et 6 s, avec AAC de 6 s. La planche et les vues agrandies ont été examinées. Les deux avertissements de sourcils absents subsistent. Le moteur et l’exemple public n’ont reçu aucune modification fonctionnelle après la suite verte ; ce complément concerne l’animation privée et sa documentation.

## Correction de la main et du premier plan du décor

Après revue utilisateur, le poing et sa manchette vectoriels de P037 sont retirés du plan retenu : le suivi correct d’un repère ne garantissait pas une main lisible. La nouvelle version `out/demo-phase2/user-hand-table/P037.mp4` conserve **le gant original découpé**, avec `HandRForm=0` pendant les 144 images. L’orientation et la cible utilisent cette fois un véritable bout de doigt de l’image source. Les pièces `nativeHandR*` restent invisibles sur chaque image vérifiée.

La table basse était entièrement peinte dans le fond opaque ; placer ensuite C1 au-dessus du décor le faisait passer devant elle. Un modèle de premier plan réutilise maintenant les pixels du décor, avec des maillages UV tracés autour du plateau et des quatre pieds. Leurs intervalles restent transparents. Ordre explicite : décor `z=0`, personnage `z=10`, table `z=20`. C1 est placé à `[890,640]`, légèrement à gauche et plus haut pour correspondre à sa position derrière la table dans le plan maître. Les UV sont conservés à dix décimales pour garder les contours alignés.

Commandes locales reproductibles, dans un dossier neuf :

```sh
node --import tsx out/demo-phase2/prepare-hand-table.ts
node --import tsx out/demo-phase2/verify-hand-table.ts
node --import tsx out/demo-phase2/render-contact.ts out/demo-phase2/user-hand-table
node node_modules/vitest/vitest.mjs run --project node test/docs-links.test.ts test/docs-commands.test.ts
```

Résultats : scène sans erreur ; les deux avertissements de sourcils préexistants subsistent. À `t=0`, `1.3`, `2.8`, `4.2` et `5.5`, les **836 pixels opaques de chevauchement** table/personnage reprennent exactement la couleur du décor : 0 pixel incorrect, erreur maximale 0 niveau/canal. Les 144 images utilisent le gant original et aucune pièce du poing synthétique. Le modèle source conserve son SHA-256. ffprobe confirme 1376×768, 24/1, H.264/yuv420p, 144 images et 6 s avec AAC. Les contrôles documentaires passent : 25 tests, 2 fichiers, code 0. Aucune modification fonctionnelle du moteur n’accompagne cette correction de composition.

La vue `P037-detail.mp4` est un simple agrandissement du même rendu pour examiner main et table ; le plan de production est `P037.mp4`. `visual-checks.json`, `contact-report.json`, `export-report.json` et les scripts restent locaux. Cette version remplace les précédentes démonstrations P037 ; elle ne prétend pas reconstruire tous les calques d’un décor automatiquement. La procédure de premier plan est ajoutée à `docs/SCENE.md` pour éviter la même erreur dans les autres plans.

## Revue du frottement : pose de doigts adaptée

La revue utilisateur du mouvement révèle une limite de `user-hand-table` : le gant de repos restait ouvert et rigide, même quand son extrémité suivait correctement un repère. Cette main glissait en bloc ; la précision du poignet ne constituait pas une validation du frottement.

Le nouvel essai `out/demo-phase2/user-rub-fingers/P037.mp4` utilise la **main aux doigts repliés de l’image maître P037**. Un contour auteur isole cette petite pose dans la texture originale ; elle est intégrée à une copie locale du rig, sans réutiliser un clip vidéo. Son maillage comporte 511 sommets. Le paramètre local `HandRCurl` fléchit progressivement les zones des doigts ; la manchette et le dos de la main restent stables dans le repère de la main. Le glissement vertical de toute la main est supprimé et remplacé par cette flexion et une faible rotation de poignet. Le premier plan de table est conservé.

```sh
node --import tsx out/demo-phase2/prepare-rub-fingers.ts
node --import tsx out/demo-phase2/verify-rub-fingers.ts
node --import tsx out/demo-phase2/render-rub-fingers.ts
```

Les scripts prennent aussi un dossier neuf directement sous `out/demo-phase2/`. Vérifications locales : aucun pli dans les poses testées, scène sans erreur, variante de frottement active sur 144 images, déformation locale des doigts jusqu’à 7,0778 pixels modèle et **0 déplacement local de la manchette**. Les cinq contrôles d’occlusion de table conservent 836 pixels de chevauchement correctement masqués, avec erreur de couleur maximale 0. Le modèle original reste intact ; seule sa copie locale reçoit cette pose et ce contrôle. L’export est H.264/yuv420p, 1376×768, 24 fps, 144 images / 6 s, AAC 6 s. Les deux avertissements de sourcils subsistent ; les 25 contrôles documentaires passent.

`P037-frottement-detail.mp4` agrandit uniquement la séquence de frottement pour sa revue. La source de main est petite : cet agrandissement n’ajoute pas de résolution. La flexion reste une déformation 2D légère d’une pose dessinée, sans articulation 3D des phalanges ni simulation de contact. Le résultat est présenté comme un nouvel essai visuel, pas comme une preuve automatique de naturel. Le point de contact numérique mesure le repère de pose ; il ne mesure pas la surface effective des doigts déformés. Le moteur public ne change pas ; `docs/GESTURES.md` précise désormais cette distinction entre pose de main et position du poignet.

## P037 : séquence complète, expression et rythme de référence

Après revue des six secondes et du clip utilisateur P037, l’action est recalée : le personnage commence déjà la main sur la tête, frotte jusqu’à environ 1,7 s, retire latéralement la main puis baisse le bras. La main de frottement cesse d’être affichée à 1,95 s ; le bras est au repos à 2,5 s. Le gant relâché d’origine remplace alors la pose de contact, qui formait auparavant un crochet lorsqu’elle restait active au bas du corps. Le clip utilisateur a servi uniquement à observer le rythme ; aucune image extraite du fichier vidéo n’est utilisée comme calque. La main provient toujours de l’image maître PNG.

L’expression reste inquiète : bouche en léger arc, regard discret et clignements autour de 2 s, 3 s et 5,5 s. Le sourcil visible est isolé avec la feature existante `brows` et animé ; celui que cachent les cheveux n’est pas inventé. Les contrôles visibles sont directement écrits dans les pistes de la scène, au lieu de demander à une expression générique un sourcil absent. Le balancement de tête est ajusté dans les limites du maillage. La table reste au premier plan.

```sh
node --import tsx out/demo-phase2/prepare-P037-rhythm.ts
node --import tsx out/demo-phase2/verify-P037-rhythm.ts
node --import tsx out/demo-phase2/render-rub-fingers.ts out/demo-phase2/P037-reference-rhythm
```

Les trois commandes acceptent un même dossier neuf directement sous `out/demo-phase2/`. La pose de main, sa flexion et la bouche sont maintenant enregistrées dans les post-opérations de `avatar.json` ; la texture de référence est interne au projet avatar. La bibliothèque est donc régénérable : deux builds donnent des modèles identiques octet par octet, les empreintes sont enregistrées, et `validateLibrary` renvoie `ok: true, diagnostics: []`.

Contrôles : 144 images inspectées, 47 avec la pose de frottement et 97 avec le gant relâché ; expression inquiète maintenue ; 0 pli et aucun diagnostic de scène. La table masque correctement les 836 pixels de chevauchement aux cinq instants vérifiés, sans erreur de couleur. Les keyforms pleines précision confirment une flexion des doigts et une manchette localement fixe ; les propriétés d’inspection arrondies ne servent pas à mesurer les écarts submillipixel. L’export reste H.264/yuv420p, 1376×768, 24 fps, 144 images / 6 s et AAC 6 s. Les planches du mouvement complet et du retrait ont été examinées, ainsi que l’aperçu agrandi. L’identité et les proportions proviennent encore de l’avatar canonique : ce travail ne prétend pas une égalité pixel à pixel avec le personnage du clip généré.

## Inventaire des fichiers

L’inventaire ci-dessous couvre chaque fichier ajouté ou modifié dans cette phase. Les artefacts privés sous `out/` n’y figurent pas.

| Fichier | Rôle |
| --- | --- |
| `AGENTS.md` | Contrat, commandes, conventions et limites de la fonctionnalité. |
| `docs/AVATAR.md` | Contrat, commandes, conventions et limites de la fonctionnalité. |
| `docs/CLI.md` | Contrat, commandes, conventions et limites de la fonctionnalité. |
| `docs/GESTURES.md` | Contrat, commandes, conventions et limites de la fonctionnalité. |
| `docs/MCP.md` | Contrat, commandes, conventions et limites de la fonctionnalité. |
| `docs/OPS.md` | Contrat, commandes, conventions et limites de la fonctionnalité. |
| `docs/SCENE.md` | Contrat, commandes, conventions et limites de la fonctionnalité. |
| `editor/src/avatar/AvatarVariants.tsx` | Poignées, géométrie et choix des variants dans l’éditeur. |
| `editor/src/avatar/geometry.ts` | Poignées, géométrie et choix des variants dans l’éditeur. |
| `editor/src/avatar/labels.ts` | Poignées, géométrie et choix des variants dans l’éditeur. |
| `editor/src/avatar/variantRows.ts` | Poignées, géométrie et choix des variants dans l’éditeur. |
| `editor/src/i18n/locales/en/avatar.ts` | Libellés et aides des nouveaux landmarks/variants dans la langue de l’éditeur. |
| `editor/src/i18n/locales/ja/avatar.ts` | Libellés et aides des nouveaux landmarks/variants dans la langue de l’éditeur. |
| `editor/src/i18n/locales/ko/avatar.ts` | Libellés et aides des nouveaux landmarks/variants dans la langue de l’éditeur. |
| `examples/README.md` | Présentation et commande de régénération de l’exemple original. |
| `examples/scenes/acting-demo/README.md` | Métadonnées ou instructions de reconstruction de l’exemple. |
| `examples/scenes/acting-demo/figure/avatar.json` | Landmarks auteurs de la fixture corps entier. |
| `examples/scenes/acting-demo/figure/figure_full.r2d.json` | Modèle généré avec bras et catalogue complet d’animations. |
| `examples/scenes/acting-demo/figure/source.png` | Illustration originale synthétique générée par script. |
| `examples/scenes/acting-demo/figure/textures/armLHandLayer.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/armLLayer.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/armRHandLayer.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/armRLayer.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/base.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeL_ball.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeL_crease.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeL_front.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeL_lower.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeL_upper.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeR_ball.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeR_crease.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeR_front.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeR_lower.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/eyeR_upper.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/layers.json` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/mouth.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_brows_angry_imageLeft.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_brows_angry_imageRight.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_brows_worried_imageLeft.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_brows_worried_imageRight.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_eyes_wide_imageLeft.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_eyes_wide_imageRight.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handL_count2_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handL_count3_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handL_fist_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handL_open_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handL_palm_up_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handL_point_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handL_thumb_up_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handR_count2_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handR_count3_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handR_fist_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handR_open_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handR_palm_up_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handR_point_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_handR_thumb_up_hand.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_mouth_frown_mouth.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_mouth_grin_mouth.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_mouth_shock_mouth.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/textures/sprite_mouth_smile_mouth.png` | Calque ou métadonnées générés du rig synthétique. |
| `examples/scenes/acting-demo/figure/variants/brows_angry.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/brows_worried.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/eyes_wide.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handL_count2.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handL_count3.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handL_fist.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handL_open.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handL_palm_up.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handL_point.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handL_thumb_up.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handR_count2.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handR_count3.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handR_fist.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handR_open.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handR_palm_up.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handR_point.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/handR_thumb_up.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/mouth_frown.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/mouth_grin.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/mouth_shock.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/figure/variants/mouth_smile.png` | Dessin de variant original, généré par le builder TypeScript. |
| `examples/scenes/acting-demo/scene.json` | Scène de démonstration des cinq actions. |
| `reports/OBJECTIFS.md` | Rapport de vérification et état des objectifs. |
| `reports/PHASE-2.md` | Rapport de vérification et état des objectifs. |
| `scripts/build-acting.ts` | Builder original reproductible des landmarks, dessins ou scènes. |
| `scripts/examples/acting-art.ts` | Builder original reproductible des landmarks, dessins ou scènes. |
| `scripts/examples/figure-avatar.ts` | Builder original reproductible des landmarks, dessins ou scènes. |
| `src/avatar/DESIGN.md` | Contrat, commandes, conventions et limites de la fonctionnalité. |
| `src/avatar/__tests__/builder.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/avatar/__tests__/parts-hash.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/avatar/__tests__/pipeline.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/avatar/__tests__/spec.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/avatar/__tests__/tools.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/avatar/__tests__/variants-model.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/avatar/__tests__/variants.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/avatar/arms-spec.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/builder.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/compile.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/features/arms.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/features/body.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/features/expressions.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/features/index.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/features/mouth.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/features/types.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/hash.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/image/hull.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/layers.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/parts.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/schema.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/spec.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/types.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/variants-areas.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/variants-sprites.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/avatar/variants-text.ts` | Spec, découpe, géométrie, rig ou variants du corps entier. |
| `src/cli/commands/acting.ts` | Commandes, outils, aide et exports publics de la fonctionnalité. |
| `src/cli/commands/avatar.ts` | Commandes, outils, aide et exports publics de la fonctionnalité. |
| `src/cli/commands/index.ts` | Commandes, outils, aide et exports publics de la fonctionnalité. |
| `src/cli/commands/reference.ts` | Commandes, outils, aide et exports publics de la fonctionnalité. |
| `src/gestures/acting.ts` | Catalogue ou génération pure des courbes, gestes, expressions et idle seedé. |
| `src/gestures/catalog.ts` | Catalogue ou génération pure des courbes, gestes, expressions et idle seedé. |
| `src/gestures/curves.ts` | Catalogue ou génération pure des courbes, gestes, expressions et idle seedé. |
| `src/gestures/idle.ts` | Catalogue ou génération pure des courbes, gestes, expressions et idle seedé. |
| `src/gestures/index.ts` | Catalogue ou génération pure des courbes, gestes, expressions et idle seedé. |
| `src/index.ts` | Commandes, outils, aide et exports publics de la fonctionnalité. |
| `src/mcp/__tests__/server.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/mcp/guide.ts` | Commandes, outils, aide et exports publics de la fonctionnalité. |
| `src/mcp/server.ts` | Commandes, outils, aide et exports publics de la fonctionnalité. |
| `src/mcp/tools/acting.ts` | Commandes, outils, aide et exports publics de la fonctionnalité. |
| `src/mcp/tools/docs.ts` | Commandes, outils, aide et exports publics de la fonctionnalité. |
| `src/node/acting.ts` | Application fichier partagée CLI/MCP, dry-run, idempotence et écriture atomique. |
| `src/node/avatar-variants.ts` | Adaptation des zones et groupes de variants optionnels aux nouveaux membres. |
| `src/node/editor-registry.ts` | Adaptation des zones et groupes de variants optionnels aux nouveaux membres. |
| `src/node/scene.ts` | Compilation des animations de scène en mémoire et analyse partagée. |
| `src/ops/__tests__/act.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/ops/__tests__/batch.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `src/ops/act.ts` | Opération act et enregistrement dans le catalogue atomique. |
| `src/ops/catalog.ts` | Opération act et enregistrement dans le catalogue atomique. |
| `src/ops/index.ts` | Opération act et enregistrement dans le catalogue atomique. |
| `src/scene/acting.ts` | Compilation des animations de scène en mémoire et analyse partagée. |
| `src/scene/evaluate.ts` | Compilation des animations de scène en mémoire et analyse partagée. |
| `src/scene/index.ts` | Compilation des animations de scène en mémoire et analyse partagée. |
| `src/scene/schema.ts` | Compilation des animations de scène en mémoire et analyse partagée. |
| `src/scene/types.ts` | Compilation des animations de scène en mémoire et analyse partagée. |
| `src/server/avatar-routes.ts` | Adaptation des zones et groupes de variants optionnels aux nouveaux membres. |
| `test/acting-example.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `test/acting-io.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `test/avatar-acting-variants.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `test/avatar-arms.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `test/avatar-variants.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `test/editor-avatar-variants.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `test/editor-avatar.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
| `test/fixtures/avatar-arms.ts` | Fixture originale et cas de validation des landmarks. |
| `test/fixtures/studio.ts` | Fixture originale et cas de validation des landmarks. |
| `test/gestures.test.ts` | Tests et attentes de régression du moteur, des adaptateurs ou de la documentation. |
