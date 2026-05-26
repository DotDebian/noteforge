/**
 * Welcome document seeded on workspace creation. Shows off the main editor
 * features (slash menu, callouts, math, mermaid, tables, footnotes,
 * transclusion targets, task lists) AND lists the higher-level capabilities
 * of NoteForge (analyse Mistral, chat RAG, daily notes, MCP, etc.). Written
 * in French to match the rest of the product copy.
 *
 * Kept as a plain string constant so we don't pay any parse cost at runtime.
 */

export const WELCOME_DOCUMENT_TITLE = 'Bienvenue sur NoteForge'

export const WELCOME_DOCUMENT_MARKDOWN = `# Bienvenue sur NoteForge 👋

NoteForge est ton espace de notes intelligent : workspaces, dossiers récursifs, éditeur markdown WYSIWYG, analyse IA et chat RAG.

Ce document est ta visite guidée. **Modifie-le, garde-le comme aide-mémoire, ou supprime-le** quand tu te sens à l'aise.

> [!TIP] Astuce
> Tape \`/\` n'importe où dans l'éditeur pour ouvrir la **slash menu** et insérer n'importe quel bloc (titre, liste, code, math, mermaid, callout, tableau, image…).

## L'éditeur en deux minutes

Markdown shortcuts natifs :

- \`# \` → titre 1, \`## \` → titre 2, jusqu'à \`### \`
- \`- \` ou \`* \` → liste à puces, \`1. \` → liste numérotée
- \`[ ] \` → tâche, \`[x] \` → tâche cochée
- \`> \` → citation
- \`\\\`\\\`\\\`\` → bloc de code
- \`**gras**\`, \`*italique*\`, \`~~barré~~\`, \`\\\`code en ligne\\\`\`

Sélectionne du texte pour faire apparaître la **bubble menu** (gras, italique, lien, code…).

### Listes de tâches

- [x] Créer ton premier workspace
- [ ] Écrire un document
- [ ] Lancer une analyse Mistral
- [ ] Poser une question dans le chat RAG

### Tableaux

| Fonction | Raccourci | Description |
| --- | --- | --- |
| Slash menu | \`/\` | Insérer n'importe quel bloc |
| Palette | \`Ctrl+K\` | Recherche + commandes |
| Wiki-link | \`[[\` | Lier un autre document |
| Transclusion | \`![[\` | Intégrer le contenu d'un autre document |

### Code et diagrammes Mermaid

\`\`\`ts
function hello(name: string): string {
  return \`Hello, \${name}!\`
}
\`\`\`

\`\`\`mermaid
graph TD
  A[Note brute] --> B[Analyse Mistral]
  B --> C[Tags + résumé]
  B --> D[Embeddings]
  D --> E[Chat RAG]
\`\`\`

### Maths LaTeX

Inline : $e^{i\\pi} + 1 = 0$.

En bloc :

$$
\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}
$$

### Callouts

> [!INFO] Info
> Les callouts existent en 4 saveurs : \`info\`, \`tip\`, \`warn\`, \`quote\`. Tape \`/callout\` pour en insérer un.

> [!WARN] Attention
> Les documents supprimés vont à la corbeille et peuvent être restaurés depuis le menu workspace.

### Bloc repliable

<details>
<summary>Clique pour déplier</summary>

Un bloc \`<details>\` parfait pour cacher des FAQ, des solutions d'exercices ou des détails techniques. Tape \`/collapsible\` pour en insérer un.

</details>

### Notes de bas de page

Tu peux ajouter des notes de bas de page[^bienvenue] qui s'accumulent automatiquement en bas du document.

[^bienvenue]: Comme celle-ci. Tape \`/footnote\` pour insérer une référence.

## Fonctionnalités IA

NoteForge utilise **Mistral** pour deux choses principales.

### 1. Analyse de document

Clique sur **"Analyze with Mistral"** dans le panneau d'insights à droite. Un seul appel JSON produit :

- un résumé court (~1 phrase) et un résumé long (3–6 phrases)
- 3 à 5 cas d'usage
- 5 à 10 tags lowercase
- 3 à 5 questions auto pour creuser le sujet
- les action items détectés dans le texte

En parallèle, le document est chunké et embeddé (Mistral Embed) pour la recherche sémantique et le chat.

### 2. Chat RAG

Bouton flottant en bas à droite — pose une question scopée au workspace courant (ou à un dossier). Pipeline interne :

1. Réécriture de la requête pour résoudre les pronoms ("et le second point ?" → "le deuxième point sur X").
2. Récupération hybride : embeddings (cosine) + BM25 fusionnés par Reciprocal Rank Fusion.
3. Reranker LLM qui re-score les candidats.
4. Réponse streamée avec citations \`[#1]\` cliquables — un clic ouvre le doc source et surligne la phrase exacte.

## Organisation

- **Workspaces** : isolent des contextes (perso / boulot / projet).
- **Dossiers récursifs** : drag & drop dans la sidebar pour réorganiser.
- **Wiki-links** : tape \`[[\` pour lier un autre document.
- **Transclusion** : tape \`![[\` pour intégrer le contenu d'un autre document.
- **Daily notes** : icône calendrier dans la sidebar, une note par jour avec un template Tâches / Notes / Liens.
- **Versions** : un snapshot est pris au plus toutes les 30 minutes lors de l'édition. Ouvre l'historique pour revenir en arrière.
- **Backlinks** : chaque doc affiche les autres documents qui le citent.
- **Graphe** : visualise les liens entre tes documents.
- **Corbeille** : suppression soft, restauration possible.

## Raccourcis utiles

| Raccourci | Action |
| --- | --- |
| \`Ctrl+K\` | Palette de commandes |
| \`Ctrl+B\` / \`Ctrl+I\` | Gras / Italique |
| \`Ctrl+Z\` / \`Ctrl+Shift+Z\` | Undo / Redo |
| \`/\` | Slash menu |
| \`[[\` | Wiki-link vers un autre doc |
| \`![[\` | Transclusion d'un autre doc |

L'auto-save tourne en continu (toutes les 500 ms après chaque frappe) — pas besoin de \`Ctrl+S\`.

## Intégrations

- **Export** : PDF, DOCX ou Markdown via le menu du workspace.
- **Import** : glisse un dossier de fichiers \`.md\` sur la sidebar pour importer en masse.
- **MCP (Model Context Protocol)** : connecte Claude Desktop à NoteForge. Clique sur l'icône prise en bas de la sidebar pour générer un token et copier la configuration prête à coller.
- **Thème** : bouton soleil / lune en bas de la sidebar pour basculer clair / sombre.

---

C'est tout ! **Supprime ce document** quand tu es prêt, ou garde-le comme aide-mémoire. Bonne prise de notes 🚀
`
