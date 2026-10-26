# Rev2D Studio — progression

Le brief utilisateur complet reste local dans `out/demo-phase0/private-brief/BRIEF-SOL.md` et dans son fichier d’origine. Le code public applique ses objectifs sans publier ce document ni les images utilisateur.

| Phase | État | Livrable |
| --- | --- | --- |
| 0 — Bibliothèque | Implémentée ; échecs amont corrigés ; suite complète verte (2 735 réussis, 2 ignorés) ; limites artistiques documentées | `reports/PHASE-0.md`, `reports/UPSTREAM-FIXES.md`, `docs/LIBRARY.md`, démos locales sous `out/demo-phase0/` |
| 1 — Scènes | Livrée et vérifiée ; 2 769 tests réussis, 2 ignorés, aucun échec ; limites artistiques explicites | `reports/PHASE-1.md`, `docs/SCENE.md`, 7 commandes CLI, 5 outils MCP, démos sous `out/demo-phase1/` |
| 2 — Jeu d’acteur | Implémentée et vérifiée techniquement ; 2 841 tests réussis, 2 ignorés, aucun échec ; bras corrigés, fidélité artistique encore partielle | `reports/PHASE-2.md`, `docs/GESTURES.md`, exemple original et 3 démos EP011 locales sous `out/demo-phase2/` |
| 3 — Épisode | Moteur livré et vérifié ; 2 861 tests réussis, 2 ignorés, aucun échec ; prototype de 120 s, dont seize plans restent à animer | `reports/PHASE-3.md`, `docs/EPISODE.md`, 7 commandes CLI/MCP, démos locales sous `out/demo-phase3/` |
| 4 — Looks | Non implémentée | Finition déterministe et mesures de performance |
| 5 — Lip-sync | Hors périmètre actuel, optionnelle | Sur demande explicite |

Les images maîtres et les fiches canoniques guident l’identité visuelle. Les clips existants servent de références de mouvement ; ils ne sont pas rejoués pour faire passer un rendu pour une animation produite par Rev2D. La bibliothèque utilisateur contient actuellement le salon et trois poses par personnage ; elle ne constitue pas encore un épisode animé.
