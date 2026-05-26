# NoteForge

Notes intelligentes : workspaces → dossiers récursifs → documents markdown WYSIWYG, avec analyse IA et chat RAG via Mistral.

## Stack
- Nuxt 3 + Nitro (fullstack)
- SQLite (better-sqlite3) + Drizzle ORM + `sqlite-vec` pour les embeddings
- Tiptap (WYSIWYG markdown)
- Tailwind CSS
- `nuxt-auth-utils` (login/password, sessions cookie, bcrypt)
- Mistral API (fetch natif, pas de SDK)
- pnpm, TypeScript strict

## Démarrage rapide
```bash
pnpm install                     # accepte les build scripts (better-sqlite3 a un binding natif)
cp .env.example .env             # mets ta clé MISTRAL_API_KEY + un NUXT_SESSION_PASSWORD ≥ 32 chars
pnpm db:migrate                  # applique les migrations sur SQLite (data/noteforge.db)
pnpm dev                         # http://localhost:3000
```

`pnpm db:generate` n'est utile que si tu modifies `server/database/schema.ts`. Les migrations initiales (`0000_*.sql`) sont déjà committées dans `server/database/migrations/`.

Au premier lancement, crée un compte via `/register`. Une workspace par défaut "My workspace" est créée automatiquement.

## Tester les fonctionnalités
- **Auth** : `/register` → une workspace est créée, tu es redirigé vers `/w/1`.
- **Sidebar** : crée des dossiers et documents via le `+` à côté de "Outline". L'arbre est récursif et collapsible.
- **Éditeur** : tape `/` pour la slash menu, sélectionne du texte pour la bubble menu. Markdown shortcuts natifs (`# `, `- `, `[ ]`, ```` ``` ```` …). L'auto-save fire toutes les 500ms.
- **IA** : ouvre un doc, écris du contenu, puis clique **"Analyze with Mistral"** dans la rail de droite. Le résumé, les tags, les questions et les action items apparaissent. Les embeddings sont calculés en arrière-plan (suggestions de docs liés visibles après ~1.5s).
- **Chat RAG** : bouton flottant en bas à droite ; le drawer permet de poser une question scopée au workspace (ou à un dossier). Sources citées dans chaque réponse, cliquables pour ouvrir le doc cible.

## Scripts
- `pnpm dev` — serveur Nuxt en mode dev
- `pnpm build` / `pnpm preview` — build + run en prod
- `pnpm typecheck` — vérifie le TS strict
- `pnpm db:generate` — génère les fichiers SQL de migration depuis le schéma Drizzle
- `pnpm db:migrate` — applique les migrations
- `pnpm db:studio` — Drizzle Studio (admin DB)

## Architecture
```
notes/
├── app.vue / pages/             # UI Vue/Nuxt
├── components/                  # composants UI + éditeur Tiptap
├── stores/                      # Pinia (workspace, doc actif)
├── layouts/default.vue          # shell avec sidebar
├── server/
│   ├── api/                     # endpoints REST + SSE
│   │   ├── auth/                # register, login, logout
│   │   ├── workspaces/          # CRUD
│   │   ├── folders/             # CRUD récursif
│   │   ├── documents/           # CRUD + autosave
│   │   └── ai/                  # analyze, embed, chat (SSE)
│   ├── database/
│   │   ├── schema.ts            # Drizzle schema
│   │   ├── client.ts            # better-sqlite3 + sqlite-vec
│   │   ├── migrate.ts           # script de migration
│   │   └── migrations/          # SQL générés
│   ├── middleware/              # auth global
│   └── utils/                   # mistral wrapper, chunking, etc.
└── data/                        # fichier SQLite (volume Docker)
```

## Modèle de données (résumé)
- **users** : id, email, passwordHash, createdAt
- **workspaces** : id, ownerId, name, createdAt
- **folders** : id, workspaceId, parentId (récursif), name, position
- **documents** : id, folderId | workspaceId, title, markdown, contentJson, updatedAt
- **doc_analyses** : docId, summaryShort, summaryLong, useCases, tags, questions, actionItems, generatedAt
- **doc_chunks** : id, docId, idx, text, embedding (sqlite-vec)
- **chat_sessions / chat_messages** : sessions et historique du chat RAG, avec sources citées par message

## Docker

Multistage `Dockerfile` (build with native toolchain → slim runtime) and `docker-compose.yml` with a bind-mounted `./data` volume for the SQLite database.

### Déploiement prod (one-shot)

```bash
git clone git@github.com:DotDebian/noteforge.git
cd noteforge
./setup.sh                       # prépare .env (session password généré, clé Mistral promptée) + data/
docker compose up -d --build     # http://localhost:3000
```

`setup.sh` est idempotent : relancé, il demande avant d'écraser le `.env` existant.

### Manuel

```bash
cp .env.example .env             # MISTRAL_API_KEY + NUXT_SESSION_PASSWORD (>= 32 chars)
docker compose up -d --build     # http://localhost:3000
docker compose logs -f noteforge
```

Boot sequence inside the container:
1. `docker/entrypoint.sh` runs `node docker/migrate.mjs`, applying every pending SQL file in `server/database/migrations/` to the volume's DB (drizzle's migrator is idempotent, so re-runs are a no-op).
2. Then `node .output/server/index.mjs` starts Nitro on `$NITRO_PORT` (default 3000).

Healthcheck: `curl -fsS http://localhost:3000/api/health` every 30s; the container reports unhealthy if the endpoint stops responding for 3 consecutive probes.

Persistent state: the `./data` directory is bind-mounted to `/app/data`. Back up `data/noteforge.db` (plus its `-wal` / `-shm` siblings if present) to snapshot the workspace.

## IA — détail
Un seul appel Mistral en JSON-mode par document génère :
- `summaryShort` (1-2 phrases)
- `summaryLong` (3-6 phrases)
- `useCases` (3-5 cas d'usage)
- `tags` (5-10 tags)
- `questions` (3-5 questions auto)
- `actionItems` (TODOs détectés)

En parallèle, le doc est chunké et embeddé (`mistral-embed`) pour la recherche sémantique et le chat RAG.

Chat RAG : SSE streamé, scope par workspace ou dossier, sources citées dans chaque réponse.
