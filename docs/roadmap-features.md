# Feuille de route — Prochaines fonctionnalités

Ce document liste les fonctionnalités à venir dans NoteForge, décrites du point de vue utilisateur.

Pour ce qui a déjà été livré, voir [`roadmap-done.md`](./roadmap-done.md).

---

## Idées laissées en attente

Ces points n'ont pas encore d'engagement fort de livraison ; ils sont là pour mémoire et discussion :

- **Collaboration multi-comptes** — versions partagées entre utilisateurs d'un même workspace.
- **Templates de documents configurables** — modèles de notes du jour, modèles de réunion, modèles de fiches de lecture.
- **Backlinks visuels améliorés** — preview à l'hover sur un `[[lien]]`, regroupement par dossier dans le panneau backlinks.

---

## Follow-ups techniques

Issus de la dernière vague de livraisons — voir la section « Follow-ups identifiés » à la fin de [`roadmap-done.md`](./roadmap-done.md) :

1. Câbler les préférences éditeur (largeur de colonne, taille de police, focus mode par défaut) sur `<EditorContent>`.
2. Faire lire `userPreferences.ai` (modèle, température, disable rewriter/reranker) par le pipeline RAG côté serveur.
3. Brancher la 2FA au login (les helpers `verifyToken` / `verifyBackupCode` sont prêts).
4. Filtre dossier de la recherche avancée : inclure les descendants (BFS comme `softDeleteUserFolder`).
5. Brancher le `?highlight=…` émis par la page de recherche sur la machinerie `jumpToCitation` de l'éditeur.
6. Exposer les nouveaux endpoints (graph, search, saved-searches) comme outils MCP.
7. Drag-reorder des recherches sauvegardées dans la sidebar.
8. PATCH session de chat pour renommer une branche.
9. Infrastructure email pour délivrer les notifications `analysisDone` / `weeklyDigest`.
