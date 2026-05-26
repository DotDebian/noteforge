# Fonctionnalités livrées

Cette feuille de route retrace ce qui a été ajouté à NoteForge dans cette session. Chaque entrée décrit le résultat côté utilisateur — pour les détails techniques, voir les fichiers cités.

---

## Écriture & édition

### Actions IA sur la sélection
La bubble menu (qui apparaît au-dessus du texte sélectionné) a un nouveau bouton **AI** :

- **Améliorer l'écriture** — corrige et fluidifie.
- **Résumer** — condense en 1-3 phrases.
- **Traduire** — vers la langue demandée (popup pour choisir).
- **Continuer** — prolonge le texte juste après la sélection.
- **Expliquer simplement** — reformule pour un débutant.
- **Changer le ton** — popup pour préciser (plus formel, plus court, etc.).

Le texte transformé s'écrit en streaming. Pendant l'écriture, un bouton **⏹ Annuler** permet d'interrompre — la transformation partielle est alors retirée. Si la requête échoue, une boîte de dialogue explique pourquoi et le texte d'origine est restauré.

Côté technique : `POST /api/ai/transform` (SSE), composable `useAiTransform`, intégration dans `EditorBubbleMenu.vue`.

### Notes mathématiques (LaTeX) via KaTeX
- `$x^2 + y^2$` rend une formule en ligne.
- `$$\int_0^1 f(x) dx$$` rend un bloc centré.
- Clic sur une formule → input de saisie ; Entrée valide, Échap annule.
- Slash commands `/math` et `/equation`.
- Round-trip markdown propre (marked + turndown).

Côté technique : extensions `math-inline.ts` / `math-block.ts`, NodeViews `MathInlineNodeView.vue` / `MathBlockNodeView.vue`, KaTeX 0.16 chargé en CDN.

### Notes de bas de page, encarts, sections repliables
Trois nouveaux blocs avec round-trip markdown :

- **Footnotes** — `texte[^1]` + définition `[^1]: contenu` en bas. Slash `/footnote` ; clic sur la référence fait défiler vers la note.
- **Callouts** — syntaxe GFM `> [!INFO]`, `> [!TIP]`, `> [!WARN]`, `> [!QUOTE]`. Carte colorée, icône, titre optionnel. Slash `/callout`.
- **Collapsible** — `<details><summary>…</summary>…</details>`. Slash `/collapse`. Le bloc replié sert aussi en lecture (le `<details>` natif fonctionne hors éditeur).

12 nouveaux tests de round-trip dans `tests/editor-markdown.test.ts`.

### Bouton de dictée (livré antérieurement, mentionné pour complétude)
Le bouton micro dans la barre d'outils dicte en realtime via Voxtral (`voxtral-mini-transcribe-realtime-2602`, 480 ms de latence cible). Pendant l'enregistrement le bouton clignote rouge, **Annuler** retire la transcription. Brique WS proxy côté serveur + AudioWorklet côté client.

### Citer un paragraphe dans le chat
Dans la bubble menu, un bouton 💬 prend la sélection, ouvre le drawer de chat, et pré-remplit la zone de saisie avec le passage en blockquote markdown. Plus qu'à poser sa question.

### Tableaux éditables
Vraie barre d'outils tableau dans l'éditeur :

- Insertion d'un tableau 3×3 avec en-têtes (slash `/table` ou bouton).
- Quand le curseur est dans un tableau, des contrôles contextuels apparaissent : ajouter ligne avant/après, ajouter colonne avant/après, supprimer ligne / colonne / tableau, basculer l'en-tête, fusionner / scinder les cellules, aligner gauche / centre / droite.
- Redimensionnement des colonnes à la souris (poignée sur la bordure).
- Round-trip markdown propre via une règle GFM personnalisée dans turndown (avec hint d'alignement, échappement des `|` et `\n`).

Côté technique : `components/editor/extensions/table.ts` (Tiptap Table + TableRow + TableHeader + TableCell étendus d'un attribut `textAlign`), règle `gfmTable` dans `composables/useEditorMarkdown.ts`.

### Tableau blanc / dessin
Insertion d'un dessin éditable directement dans un document (slash `/draw`).

- Outils : crayon, rectangle, ellipse, flèche, post-it (sticky note), texte, sélection, suppression, undo, clear.
- La scène est conservée dans le document en base64 (`data-scene`) — fonctionne hors-ligne.
- Une prévisualisation PNG (`data-preview`) est générée à chaque sauvegarde et réutilisée par les exports PDF/DOCX.
- Historique d'undo en mémoire (40 snapshots roulants).

Côté technique : `components/editor/extensions/whiteboard.ts` + `WhiteboardNodeView.vue` (Konva chargé dynamiquement en `onMounted` pour éviter le SSR).

### Transclusion d'un autre document — `![[doc]]`
Affiche le contenu d'un autre document directement à l'intérieur du document courant.

- Syntaxe `![[Titre du doc]]` ou `![[123]]` (id numérique).
- Résolution par titre (insensible à la casse) via le tree store, ou par id.
- Le contenu transclus est rendu en lecture seule, avec un en-tête « ↪ Titre » cliquable vers le doc source.
- Si la source change, la transclusion se met à jour automatiquement (watcher sur `treeStore.documents`).
- Les `![[…]]` imbriqués dans une transclusion sont neutralisés (anti-récursion).
- Si la cible est introuvable : placeholder « ❌ Document introuvable ».

Côté technique : `components/editor/extensions/transclusion.ts` + `TransclusionNodeView.vue`, marked tokenizer inline + règle turndown dans `useEditorMarkdown.ts`. Cache fetch module-level invalidé par `id:updatedAt:title`.

### Auto-création des notes datées via wiki-link
Taper `[[2026-05-25]]` propose en tête de la liste un item « 📅 Créer la note du jour ». À la sélection, la note du jour est créée à la volée (find-or-create idempotent) puis le lien est inséré.

Le service `findOrCreateDailyNote` existait déjà côté serveur (livré avec le widget calendrier) ; il est maintenant accessible depuis n'importe quel endroit du document.

Côté technique : modif `components/editor/extensions/WikiLink.ts` (discriminator `kind: 'doc' | 'createDaily'`), placeholder inséré synchrone puis ré-écrit en lien réel quand le POST résout.

---

## Organisation & navigation

### Notes du jour (journal)
Mini-calendrier dans la barre latérale, juste au-dessus de la corbeille :

- En-tête repliable (clic sur **Journal** déplie le mois).
- Bouton **Aujourd'hui** qui crée/ouvre immédiatement la note du jour.
- Navigation `‹` / `›` mois par mois. Click sur le mois ramène à aujourd'hui.
- Un point sous une date = une note existe pour ce jour.
- Click sur une date → POST `/api/workspaces/:id/daily-note` find-or-create (titre = `YYYY-MM-DD`, template avec sections Tâches / Notes / Liens), puis navigation vers la note.

Côté technique : composant `DailyNotesCalendar.vue`, endpoints `daily-note.post.ts` + `daily-notes.get.ts`, service `findOrCreateDailyNote` + `listDailyNotesForMonth` dans `server/utils/notes.ts`.

### Page de tags
- `/w/:id/tags` — liste de tous les tags du workspace (extraits de `doc_analyses.tags`), avec le nombre de notes pour chacun.
- Click sur un tag → liste filtrée des notes correspondantes (résolues via le tree store).
- Lien dans la barre latérale, au-dessus de la corbeille.

Côté technique : endpoint `workspaces/[id]/tags.get.ts`, page `pages/w/[workspaceId]/tags.vue`.

### Vue graphe — `/w/:id/graph`
Nouvelle page qui affiche **la carte de toutes les notes** sous forme de graphe force-directed :

- Chaque note est un point ; chaque `[[lien]]` ou backlink est un trait.
- Les notes qui partagent des tags forment des clusters visuels (couleur par tag dominant).
- Zoom / déplacement / drag d'un nœud / isolation d'un nœud sélectionné.
- Panneau latéral avec filtre par tag, focus, légende couleurs.

Algorithme : simulation Verlet O(n²) maison (répulsion + ressorts d'attraction sur les arêtes + gravité centrale + damping 0.85). S'arrête quand l'énergie cinétique chute sous un seuil pendant 30 frames, ou après 6 s. Aucune dépendance externe.

Anti-hairball : pour les workspaces > 50 docs, seuls les 3 tags les plus fréquents génèrent des arêtes `tag` ; les tags partagés par > 25 docs sont aussi écartés.

Côté technique : `pages/w/[workspaceId]/graph.vue` (canvas HTML5 + boucle `requestAnimationFrame`), endpoint `workspaces/[id]/graph.get.ts` (nodes + edges).

### Recherche avancée — `/w/:id/search`
Page de recherche complète, en complément de la palette éclair :

- Champ `q` (debounced 300 ms).
- Filtres : tag, dossier, date (from / to), tri (relevance / récent / ancien).
- Snippet avec termes surlignés (FTS5 `snippet()` côté SQLite, ré-écrit en `**…**` côté client pour éviter l'injection).
- Pagination (limit + offset).
- L'URL contient l'état complet de la recherche → liens partageables, rechargement sans perte.

Côté technique : `pages/w/[workspaceId]/search.vue`, endpoint `workspaces/[id]/search.get.ts` (FTS5 + filtres SQL + json_each pour les tags).

### Recherches sauvegardées
- Bouton **« Sauvegarder cette recherche »** sur la page search → demande un nom et persiste la query complète.
- Section repliable **Recherches** dans la barre latérale, sous Tags.
- Click sur une recherche sauvegardée → navigation vers `/w/:id/search?…` avec la query ré-appliquée.
- Rename / suppression via menu contextuel.

Côté technique : table `saved_searches` (userId + workspaceId + name + queryJson + position), endpoints `saved-searches/*` (CRUD), store `stores/savedSearches.ts` (optimiste + rollback), section dans `AppSidebar.vue`.

### Opérations groupées dans la barre latérale
Toggle en haut du tree pour entrer en mode sélection multi :

- Cases à cocher devant chaque document et dossier.
- Barre d'actions collante en bas du tree avec compteur :
  - **Déplacer** vers un autre dossier (picker).
  - **Mettre à la corbeille** (confirmation).
  - **Ajouter / retirer un tag** sur les docs sélectionnés (best-effort, ignore les docs sans analyse).
  - **Exporter** en lot → ZIP HTML streamé.
- Le drag & drop existant est désactivé quand le mode multi est actif.

Endpoint unique `POST /api/documents/bulk { action, docIds, … }` qui renvoie `{ ok, errors }` par doc (best-effort, pas de bail transactionnel).

Côté technique : `stores/bulkSelect.ts` (état + mode), `server/api/documents/bulk.post.ts`, modifs `AppSidebar.vue` + `sidebar/FolderTreeNode.vue`.

---

## Chat IA

### Régénérer et modifier les messages
- **Regenerate** sur tout message assistant (bouton apparaît au survol). Supprime la réponse et relance le streaming depuis le dernier message utilisateur.
- **Edit** sur tout message utilisateur. Ouvre un textarea inline avec Save / Cancel et raccourci `Ctrl/Cmd+Enter`. Au Save : message mis à jour, tout ce qui suit est supprimé, nouvelle réponse streamée.
- Les deux boutons sont désactivés pendant un envoi en cours.

Côté technique : endpoints `DELETE /api/ai/chat/sessions/:id/messages` et `PATCH .../messages/:msgId`, actions `regenerate` / `editAndResend` dans `stores/chat.ts`.

### Brancher depuis un message
Bouton **⎇ Brancher** au survol de n'importe quel message (utilisateur ou assistant) :

- Crée une nouvelle session qui contient tous les messages jusqu'à celui-là (inclus).
- Conserve le contexte (`scopeFolderId`, `scopeDocId`).
- Titre par défaut : `↪ {titre d'origine}` (capé 80 caractères).
- La nouvelle session est ajoutée en haut de la liste, identifiée par un préfixe `↪` et un liseré accent à gauche ; le titre de la session parente apparaît en tooltip.
- Désactivé pendant un streaming en cours et sur les messages optimistes pas encore persistés.

Côté technique : colonnes `parentSessionId` + `branchFromMessageId` ajoutées à `chat_sessions` (migration 0017), endpoint `POST /api/ai/chat/sessions/:id/branch`, action `branchFromMessage` dans `stores/chat.ts`.

---

## Export & impression

### Export HTML
- Par document : `GET /api/documents/:id/export.html` — HTML auto-suffisant, CSS inline qui reprend le style éditorial (titres serif, code monospace, callouts/blockquotes), KaTeX en CDN pour les maths.
- Par workspace : `GET /api/workspaces/:id/export?format=html` — ZIP de fichiers HTML.
- Disposition `attachment` avec nom de fichier slugifié.

### Export PDF
- Par document : `GET /api/documents/:id/export.pdf`.
- Par workspace : `GET /api/workspaces/:id/export.pdf` — un seul PDF concaténé, ordre dossier puis position, nouvelle page par doc.
- Rendu pur JS via `pdfkit` (pas de Chromium) : A4, 50 px marges, Times-Roman corps + Helvetica titres + Courier code, pagination « Page N / Total » en pied de page.
- Tableaux dessinés à la main avec calcul de hauteur, callouts avec liseré + bandeau coloré, images locales (`/uploads/…`) résolues en direct sur disque, images distantes via fetch avec budget 4 s.
- Math : rendu en monospace dans un encart bordé (KaTeX serveur écarté — trop lourd).
- Whiteboard : la prévisualisation PNG embarquée est utilisée si présente, sinon placeholder.

### Export DOCX
- Par document : `GET /api/documents/:id/export.docx`.
- Par workspace : `GET /api/workspaces/:id/export.docx` — un seul DOCX concaténé, idem PDF.
- Construit via la lib `docx` à partir du token-stream `marked.lexer()` (pas de HTML intermédiaire).
- Supporte : titres, paragraphes, gras/italique/strike/code spans, code blocs (Consolas), listes bullet/ordonnée (numbering registry), blockquotes (left-border), HR, hyperliens externes, images inline (PNG/JPEG/GIF/BMP), tableaux natifs avec en-tête shadé, callouts (left-border + shading per-paragraphe).
- Math : Consolas + bordure.

Côté technique : `server/utils/export-pdf.ts` + `export-docx.ts`, endpoints `documents/[id]/export.pdf.get.ts` + `.docx.get.ts` + variantes workspace.

---

## Compte & paramètres

### Page Paramètres — sections complètes
La page `/settings` couvre désormais :

- **Profil** : nom affiché, email lecture seule.
- **Mot de passe** : changement avec vérification de l'actuel.
- **Apparence** : light / dark.
- **Langue** : EN / FR.
- **Éditeur** : largeur de colonne (étroit / normal / large), taille de police (petit / normal / grand), focus mode par défaut. Persistés ; la mise en application côté éditeur reste un follow-up.
- **IA** : modèle Mistral préféré (small / medium / large + champ libre), température (0.0–1.5), désactivation rewriter / reranker. Persistés ; bandeau jaune précise que le serveur ne les lit pas encore.
- **Notifications** : analyse terminée (actif), mentions dans un doc (badge « Bientôt »), digest hebdo (badge « Bientôt »).
- **Sécurité** :
  - Raccourci vers la gestion des tokens MCP.
  - **Double authentification (TOTP)** complète : enrollment avec QR code + secret texte + code 6 chiffres, codes de récupération affichés une fois avec gating « j'ai noté », désactivation password-confirmed. Tolérance ±30 s. Codes backup hashés SHA-256, secrets chiffrés AES-256-GCM avec clé dérivée de `NUXT_SESSION_PASSWORD`.

Côté technique : table `user_preferences` (JSON par section), table `user_totp` (secret chiffré + backup codes hashés), endpoints `preferences/*` + `auth/2fa/*` (setup / enable / disable / status), composables `useUserPreferences` + `useTwoFactor`, `server/utils/totp.ts` (otplib + qrcode).

L'enforcement 2FA au login reste un follow-up — les helpers `verifyToken` et `verifyBackupCode` sont prêts à être branchés dans `login.post.ts`.

---

## Sécurité

### Protection des connexions
- **Token bucket en mémoire** sur `/api/auth/login` et `/api/auth/register`.
- IP : 10 tentatives / 5 min.
- Email : 5 tentatives ratées / 10 min — au-delà, comptes verrouillés temporairement.
- Réponse 429 avec `Retry-After` (secondes) + `data.retryAfterMs` ; le frontend affiche un message convivial.
- Une connexion réussie libère le bucket email (les comptes honnêtes ne brûlent pas leur quota).

Côté technique : `server/utils/rateLimit.ts` (`consume` / `release`), appliqué dans `login.post.ts` et `register.post.ts`.

### Double authentification (2FA)
Voir « Page Paramètres » plus haut — flow complet livré, enforcement login en follow-up.

---

## Déploiement

### Docker prêt à l'emploi
- Dockerfile multi-stage : install → build → runtime minimal.
- Entrypoint `docker/entrypoint.sh` qui exécute les migrations Drizzle au démarrage avant d'exec'er le serveur Nitro.
- Healthcheck Docker : `curl -fsS http://localhost:3000/api/health || exit 1`.
- Volume `./data:/app/data` (DB SQLite + uploads).
- `docker-compose.yml` exigeant `MISTRAL_API_KEY` et `NUXT_SESSION_PASSWORD` en env.
- README mis à jour : `docker compose up -d --build` suffit.

---

## Vérification de fin de session

- `pnpm typecheck` : ✅ clean (exit 0, vue-tsc 0 erreur).
- `pnpm test` : ✅ 77/77 tests passent.
- Migration `0017_normal_zuras.sql` appliquée (saved_searches, user_preferences, user_totp + colonnes `parent_session_id` / `branch_from_message_id` sur chat_sessions).
- Dépendances installées : `@tiptap/extension-table*` (v2.27.2), `docx`, `pdfkit` (+ types), `otplib`, `qrcode` (+ types), `konva`.

---

## Follow-ups identifiés

Pendant l'implémentation, plusieurs branchements ont été laissés en l'état — code prêt mais pas câblé au flux principal :

1. **Préférences éditeur** : `editorColumnWidthClass` / `editorFontSizeClass` exposés par `useUserPreferences()` mais non appliqués sur `<EditorContent>` (le composant éditeur n'a pas été touché). Une-ligne à ajouter.
2. **Préférences IA serveur** : `chat.post.ts` / `query-rewrite.ts` / `rerank.ts` ne lisent pas encore `userPreferences.ai`. Une lecture sur `requireUser` suffit.
3. **Focus mode par défaut** : `useFocusMode` reste localStorage-only ; à brancher sur la préf sauvegardée au mount de la page doc.
4. **2FA au login** : les helpers `verifyToken` / `verifyBackupCode` sont prêts ; à brancher dans `server/api/auth/login.post.ts` quand `user_totp.enabled = true`.
5. **Filtre dossier avec descendants** dans la recherche avancée : actuellement exact-match `folderId`. Réutiliser le BFS de `softDeleteUserFolder` pour inclure les descendants.
6. **Highlight `?q=` côté éditeur** : la page search émet `?highlight=…` à la navigation, mais la machinerie `jumpToCitation` n'est pas encore branchée dessus.
7. **MCP tools graph / search / saved-searches** : exposables trivialement via `server/utils/notes.ts`.
8. **Reorder drag des recherches sauvegardées** : la colonne `position` + PATCH existent, l'UX drag n'est pas branchée.
9. **Rename d'une branche de chat** : pas d'endpoint PATCH session (seulement PATCH message).
10. **Notifications par email** : pas d'infra mail — `analysisDone` est storable mais pas délivré.
