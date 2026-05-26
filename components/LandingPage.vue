<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

// Tiny scroll-reveal: walks `.reveal` elements and adds `.is-in` when they
// cross the viewport. Pure CSS handles the fade/slide. We don't pull in any
// library — the landing is presentational and intersection-observer is
// universally available.
const rootEl = ref<HTMLElement | null>(null)
let io: IntersectionObserver | null = null

onMounted(() => {
  if (!rootEl.value || typeof IntersectionObserver === 'undefined') return
  io = new IntersectionObserver(
    entries => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add('is-in')
          io?.unobserve(e.target)
        }
      }
    },
    { rootMargin: '0px 0px -8% 0px', threshold: 0.08 },
  )
  rootEl.value.querySelectorAll('.reveal').forEach(el => io!.observe(el))
})

onBeforeUnmount(() => io?.disconnect())
</script>

<template>
  <div ref="rootEl" class="landing">
    <!-- ═════════════════════════════════════════════════════════════════
         § HERO
         ═════════════════════════════════════════════════════════════════ -->
    <section class="hero">
      <div class="hero-grid">
        <div class="hero-copy">
          <p class="eyebrow hero-eyebrow">
            <span class="section-marker">§</span>
            <span>Pour penser par écrit</span>
            <span class="eyebrow-dot" aria-hidden="true">·</span>
            <span class="eyebrow-version">v0.1</span>
          </p>

          <h1 class="hero-title">
            <span class="hero-line line-1">Penser,</span>
            <span class="hero-line line-2">sur du papier</span>
            <span class="hero-line line-3">
              qui <span class="underlined">se souvient</span><span class="hero-period">.</span>
            </span>
          </h1>

          <p class="hero-lede">
            Un éditeur markdown <em>WYSIWYG</em>, des workspaces chiffrés
            bout en bout, et une IA qui lit tes pages pour te répondre — avec
            citation des phrases exactes.
          </p>

          <div class="hero-cta">
            <NuxtLink to="/register" class="btn btn-primary">
              <span>Créer un compte</span>
              <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                <path d="M3 8h10 M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </NuxtLink>
            <NuxtLink to="/login" class="btn btn-ghost">
              <span>Se connecter</span>
            </NuxtLink>
          </div>

          <ul class="hero-meta">
            <li><span class="m-dot" /> Mistral AI</li>
            <li><span class="m-dot" /> Chiffrement AES-256-GCM</li>
            <li><span class="m-dot" /> MCP — Claude Desktop</li>
            <li><span class="m-dot" /> Code ouvert</li>
          </ul>
        </div>

        <!-- Live "specimen" — a markdown-shortcut transformation that loops.
             Three states: typed source → caret → rendered output. -->
        <aside class="hero-specimen" aria-hidden="true">
          <div class="specimen-frame">
            <header class="specimen-bar">
              <span class="bar-dots">
                <i /><i /><i />
              </span>
              <span class="bar-title">notes / mardi-soir.md</span>
              <span class="bar-saving">●&nbsp;sauvegardé</span>
            </header>

            <div class="specimen-body">
              <div class="spec-row spec-row-a">
                <span class="spec-prompt">›</span>
                <span class="spec-typed"># Mardi soir, sous la lampe</span>
              </div>
              <div class="spec-row spec-row-b">
                <h3 class="spec-h">Mardi soir, sous la lampe</h3>
              </div>

              <div class="spec-row spec-row-c">
                <span class="spec-prompt">›</span>
                <span class="spec-typed">- [ ] Relire <span class="wikilink">[[Phénoménologie]]</span></span>
              </div>
              <div class="spec-row spec-row-d">
                <label class="spec-task">
                  <input type="checkbox" disabled />
                  <span>Relire <a class="wikilink-rendered">Phénoménologie</a></span>
                </label>
              </div>

              <div class="spec-row spec-row-e">
                <span class="spec-prompt">›</span>
                <span class="spec-typed">$e^{i\pi} + 1 = 0$</span>
              </div>
              <div class="spec-row spec-row-f">
                <span class="spec-math">e<sup>iπ</sup> + 1 = 0</span>
              </div>

              <div class="spec-caret-row">
                <span class="spec-caret" />
              </div>
            </div>
          </div>

          <!-- Marginalia floating around the specimen -->
          <span class="margin-note margin-note-1">
            <span class="mn-arrow">↖</span>
            <span>raccourcis markdown natifs</span>
          </span>
          <span class="margin-note margin-note-2">
            <span>wiki-link <code>[[…]]</code></span>
            <span class="mn-arrow">↘</span>
          </span>
        </aside>
      </div>

      <div class="hero-rule" aria-hidden="true">
        <span class="rule-glyph">⌘</span>
      </div>
    </section>

    <!-- ═════════════════════════════════════════════════════════════════
         § I — ÉDITEUR
         ═════════════════════════════════════════════════════════════════ -->
    <section id="editeur" class="chapter">
      <header class="chapter-header reveal">
        <p class="eyebrow"><span class="section-marker">§ I</span><span>Écrire</span></p>
        <h2 class="chapter-title">
          Du markdown, comme tu <span class="underlined-soft">l'aimes</span>.
        </h2>
        <p class="chapter-lede">
          Un éditeur Tiptap qui parle markdown couramment. Tape les
          raccourcis et ils se transforment en blocs riches : titres,
          listes, tableaux, math, callouts, mermaid, code surligné,
          wiki-links, transclusions, notes de bas de page.
        </p>
      </header>

      <!-- Specimen: a faux document with all the editor capabilities -->
      <div class="document-specimen reveal">
        <div class="doc-paper">
          <p class="doc-meta"><span>26 mai 2026</span><span class="doc-meta-dot">·</span><span>3 min de lecture</span></p>
          <h3 class="doc-title">Carnet de lecture, semaine 21</h3>

          <p class="doc-p">
            Husserl écrit que la <em>conscience</em> est toujours
            <strong>conscience de quelque chose</strong>. C'est ce qu'il appelle
            l'intentionnalité — un fil tendu entre le sujet et son monde.
          </p>

          <div class="doc-callout doc-callout-tip">
            <span class="callout-glyph">!</span>
            <div>
              <p class="callout-title">À retenir</p>
              <p class="callout-body">L'objet visé n'a pas besoin d'exister réellement pour être <em>visé</em>.</p>
            </div>
          </div>

          <ul class="doc-tasks">
            <li><input type="checkbox" checked disabled> Lire l'introduction de Levinas</li>
            <li><input type="checkbox" disabled> Comparer avec Merleau-Ponty</li>
            <li><input type="checkbox" disabled> Écrire une fiche sur <a class="wikilink-rendered">Idées I</a></li>
          </ul>

          <pre class="doc-code"><span class="hl-c">// hypothèse de travail</span>
<span class="hl-k">const</span> <span class="hl-v">intentionnalité</span> = (sujet, objet) =&gt; ({
  <span class="hl-a">de</span>: sujet,
  <span class="hl-a">vers</span>: objet,
})</pre>

          <div class="doc-math">
            <span>∫</span>
            <span class="math-body"><sub>−∞</sub><sup>+∞</sup>&nbsp;e<sup>−x²</sup> dx = √π</span>
          </div>
        </div>

        <!-- Floating bubble menu over the doc, like the real editor -->
        <div class="bubble-menu" aria-hidden="true">
          <button class="bm-btn bm-active"><strong>B</strong></button>
          <button class="bm-btn"><em>I</em></button>
          <button class="bm-btn"><span style="text-decoration: line-through;">S</span></button>
          <span class="bm-sep" />
          <button class="bm-btn bm-link">
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
              <path d="M6.5 9.5 9.5 6.5 M5 11a2.5 2.5 0 0 1 0-3.5l2-2 M11 5a2.5 2.5 0 0 1 0 3.5l-2 2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
            </svg>
          </button>
          <button class="bm-btn"><code>&lt;/&gt;</code></button>
        </div>
      </div>

      <!-- Shortcut grid: each chip shows the trigger + the resulting block -->
      <ul class="shortcut-grid reveal">
        <li class="chip"><code>/</code><span>Slash menu — tout insérer</span></li>
        <li class="chip"><code>#</code><span>Titre 1, 2, 3</span></li>
        <li class="chip"><code>- [ ]</code><span>Liste de tâches</span></li>
        <li class="chip"><code>&gt;&nbsp;[!TIP]</code><span>Callout (4 saveurs)</span></li>
        <li class="chip"><code>```</code><span>Code surligné</span></li>
        <li class="chip"><code>$$ … $$</code><span>Math LaTeX en bloc</span></li>
        <li class="chip"><code>|&nbsp;|&nbsp;|</code><span>Tableau éditable</span></li>
        <li class="chip"><code>[[ ]]</code><span>Wiki-link</span></li>
        <li class="chip"><code>![[ ]]</code><span>Transclusion</span></li>
        <li class="chip"><code>[^N]</code><span>Note de bas de page</span></li>
        <li class="chip"><code>&lt;details&gt;</code><span>Bloc repliable</span></li>
        <li class="chip"><code>mermaid</code><span>Diagrammes</span></li>
      </ul>
    </section>

    <!-- ═════════════════════════════════════════════════════════════════
         § II — IA
         ═════════════════════════════════════════════════════════════════ -->
    <section id="ia" class="chapter chapter-alt">
      <header class="chapter-header reveal">
        <p class="eyebrow"><span class="section-marker">§ II</span><span>Relier &amp; demander</span></p>
        <h2 class="chapter-title">
          Une mémoire qui répond,<br />
          avec <span class="underlined-soft">citations</span>.
        </h2>
        <p class="chapter-lede">
          Chaque document est résumé, étiqueté, embeddé. Le chat RAG répond
          à tes questions en s'appuyant sur tes propres notes, et chaque
          phrase de réponse cite la phrase source que tu peux ouvrir d'un
          clic.
        </p>
      </header>

      <div class="ai-grid">
        <article class="ai-card reveal">
          <p class="card-eyebrow">Analyse Mistral</p>
          <h3 class="card-title">Un seul appel, six éclairages.</h3>
          <ul class="card-list">
            <li><span class="bullet">→</span>Résumé court (~1 phrase) + long (3–6 phrases)</li>
            <li><span class="bullet">→</span>3 à 5 cas d'usage</li>
            <li><span class="bullet">→</span>5 à 10 tags <code>lowercase</code></li>
            <li><span class="bullet">→</span>3 à 5 questions pour creuser</li>
            <li><span class="bullet">→</span>Action items détectés</li>
            <li><span class="bullet">→</span>Chunking + embeddings en arrière-plan</li>
          </ul>
        </article>

        <article class="ai-card reveal">
          <p class="card-eyebrow">Chat RAG</p>
          <h3 class="card-title">Pipeline hybride, reranké.</h3>
          <ol class="card-pipeline">
            <li><b>1.</b> Réécriture de la requête — pronoms résolus, contexte injecté</li>
            <li><b>2.</b> Récupération hybride — <code>vec0</code> cosine + FTS5 BM25</li>
            <li><b>3.</b> Reciprocal Rank Fusion sur les deux flux</li>
            <li><b>4.</b> Reranker LLM, oversampling × 3</li>
            <li><b>5.</b> Réponse streamée, citations <code>[#1]</code> cliquables</li>
          </ol>
        </article>
      </div>

      <!-- SVG pipeline diagram (animated dot flow) -->
      <figure class="pipeline reveal" aria-hidden="true">
        <svg viewBox="0 0 880 130" xmlns="http://www.w3.org/2000/svg" class="pipeline-svg">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0 0 L8 5 L0 10 z" fill="currentColor" />
            </marker>
          </defs>

          <!-- Boxes -->
          <g class="pl-box" transform="translate(8 38)">
            <rect width="120" height="54" rx="6" />
            <text x="60" y="24" text-anchor="middle" class="pl-label">QUESTION</text>
            <text x="60" y="40" text-anchor="middle" class="pl-sub">utilisateur</text>
          </g>
          <g class="pl-box" transform="translate(168 38)">
            <rect width="132" height="54" rx="6" />
            <text x="66" y="24" text-anchor="middle" class="pl-label">RÉÉCRITURE</text>
            <text x="66" y="40" text-anchor="middle" class="pl-sub">mistral-small</text>
          </g>
          <g class="pl-box pl-box-double" transform="translate(340 14)">
            <rect width="148" height="36" rx="6" />
            <text x="74" y="22" text-anchor="middle" class="pl-label">VEC0 · cosine</text>
          </g>
          <g class="pl-box pl-box-double" transform="translate(340 80)">
            <rect width="148" height="36" rx="6" />
            <text x="74" y="22" text-anchor="middle" class="pl-label">FTS5 · BM25</text>
          </g>
          <g class="pl-box" transform="translate(528 38)">
            <rect width="112" height="54" rx="6" />
            <text x="56" y="24" text-anchor="middle" class="pl-label">RRF</text>
            <text x="56" y="40" text-anchor="middle" class="pl-sub">k = 60</text>
          </g>
          <g class="pl-box" transform="translate(680 38)">
            <rect width="132" height="54" rx="6" />
            <text x="66" y="24" text-anchor="middle" class="pl-label">RERANK</text>
            <text x="66" y="40" text-anchor="middle" class="pl-sub">LLM × 0.7</text>
          </g>

          <!-- Arrows -->
          <g class="pl-edges" stroke="currentColor" stroke-width="1.2" fill="none" marker-end="url(#arrow)">
            <path d="M128 65 L168 65" />
            <path d="M300 60 C 320 60, 320 32, 340 32" />
            <path d="M300 70 C 320 70, 320 98, 340 98" />
            <path d="M488 32 C 508 32, 508 60, 528 60" />
            <path d="M488 98 C 508 98, 508 70, 528 70" />
            <path d="M640 65 L680 65" />
          </g>

          <!-- Flowing dot showing data movement -->
          <circle r="3.2" class="pl-dot" fill="currentColor">
            <animateMotion dur="6s" repeatCount="indefinite"
              path="M8 65 L168 65 C 260 65, 260 32, 340 32 L488 32 C 508 32, 508 60, 528 60 L640 65 L820 65" />
          </circle>
          <circle r="3.2" class="pl-dot pl-dot-2" fill="currentColor">
            <animateMotion dur="6s" begin="3s" repeatCount="indefinite"
              path="M8 65 L168 65 C 260 65, 260 98, 340 98 L488 98 C 508 98, 508 70, 528 70 L640 65 L820 65" />
          </circle>
        </svg>

        <figcaption class="pipeline-cap">
          Réécriture → hybride vec0 + BM25 → fusion RRF → reranker LLM → réponse streamée
        </figcaption>
      </figure>

      <!-- Faux chat exchange showing citation chips -->
      <div class="chat-specimen reveal">
        <div class="chat-msg chat-msg-user">
          <span class="msg-label">TOI</span>
          <p>Quels thèmes reviennent dans mes notes de philo cette semaine&nbsp;?</p>
        </div>
        <div class="chat-msg chat-msg-ai">
          <span class="msg-label">NOTEFORGE</span>
          <p>
            Trois fils tiennent ensemble&nbsp;: la
            <strong>phénoménologie du temps</strong> — tu y reviens lundi et
            mercredi <a class="citation">[#1]</a>, une note sur <em>Heidegger</em>
            et l'<em>être-au-monde</em> <a class="citation">[#2]</a>, et un retour
            à Husserl mardi soir <a class="citation">[#1]</a>.
          </p>
          <ul class="chat-sources">
            <li><span class="src-num">#1</span><span class="src-title">Carnet — semaine 21</span><span class="src-snippet">« La conscience est toujours conscience de… »</span></li>
            <li><span class="src-num">#2</span><span class="src-title">Heidegger, lecture du jeudi</span><span class="src-snippet">« Être-au-monde n'est pas un constat mais… »</span></li>
          </ul>
        </div>
      </div>
    </section>

    <!-- ═════════════════════════════════════════════════════════════════
         § III — CHIFFREMENT
         ═════════════════════════════════════════════════════════════════ -->
    <section id="chiffrement" class="chapter">
      <header class="chapter-header reveal">
        <p class="eyebrow"><span class="section-marker">§ III</span><span>Chiffrer</span></p>
        <h2 class="chapter-title">
          Toi seul as <span class="underlined-soft">la clé</span>.
        </h2>
        <p class="chapter-lede">
          Une clé de chiffrement par compte, dérivée de ton mot de passe.
          Sans le mot de passe — ou la clé de récupération — le disque
          reste illisible. Pour nous comme pour n'importe qui d'autre.
        </p>
      </header>

      <!-- Visual: a document title getting wrapped into an enc:v1 envelope -->
      <div class="vault reveal">
        <div class="vault-row">
          <span class="vault-label">titre&nbsp;</span>
          <span class="vault-plain">"Carnet de lecture, semaine 21"</span>
        </div>
        <div class="vault-arrow" aria-hidden="true">
          <svg viewBox="0 0 24 32" width="22" height="28"><path d="M12 2v22 M5 18l7 8 7-8" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" /></svg>
          <span class="vault-arrow-label">AES-256-GCM · IV unique</span>
        </div>
        <div class="vault-row vault-row-cipher">
          <span class="vault-label">stocké</span>
          <code class="vault-cipher">enc:v1:<span class="cipher-iv">Yw3FjK2pLm8nQ</span><span class="cipher-tag">rX7vH9zT5kAa</span><span class="cipher-ct">UbWcDeFgHiJkLmNoPqRsTuVwXyZ012…</span></code>
        </div>
        <div class="vault-legend">
          <span><i class="lg lg-iv" /> nonce (12)</span>
          <span><i class="lg lg-tag" /> tag GCM (16)</span>
          <span><i class="lg lg-ct" /> texte chiffré</span>
        </div>
      </div>

      <ul class="pillars reveal">
        <li>
          <p class="pillar-num">01</p>
          <h4 class="pillar-h">Clé personnelle (DEK)</h4>
          <p class="pillar-b">Une clé par utilisateur, dérivée de ton mot de passe via <code>scrypt</code>. Présente en mémoire uniquement le temps de ta session.</p>
        </li>
        <li>
          <p class="pillar-num">02</p>
          <h4 class="pillar-h">Clé de récupération</h4>
          <p class="pillar-b">Affichée une seule fois à l'inscription. Sans mot de passe ET sans clé, personne — pas même nous — ne lit tes notes.</p>
        </li>
        <li>
          <p class="pillar-num">03</p>
          <h4 class="pillar-h">Champ par champ</h4>
          <p class="pillar-b">Titres, markdown, chunks, analyses, messages de chat. Embeddings et FTS5 restent en clair pour la recherche.</p>
        </li>
      </ul>
    </section>

    <!-- ═════════════════════════════════════════════════════════════════
         § IV — ATELIER
         ═════════════════════════════════════════════════════════════════ -->
    <section id="atelier" class="chapter chapter-alt">
      <header class="chapter-header reveal">
        <p class="eyebrow"><span class="section-marker">§ IV</span><span>Organiser</span></p>
        <h2 class="chapter-title">
          Workspaces, dossiers,<br />
          et tout ce qui les <span class="underlined-soft">relie</span>.
        </h2>
        <p class="chapter-lede">
          Des contextes étanches pour ton roman, ton wiki d'équipe, ta
          collection de recettes. Tu relies, tu transclus, tu retrouves.
        </p>
      </header>

      <div class="atelier-grid">
        <!-- ASCII tree specimen -->
        <pre class="tree-specimen reveal" aria-hidden="true">📁 <span class="t-ws">Notes</span>
├── 📁 <span class="t-folder">Romans en cours</span>
│   ├── 📄 Chapitre I
│   └── 📄 Chapitre II         <span class="t-link">→ [[Chapitre I]]</span>
├── 📁 <span class="t-folder">Recherche</span>
│   ├── 📄 Phénoménologie       <span class="t-back">← 4 backlinks</span>
│   └── 📄 Husserl, notes
├── 📁 <span class="t-folder">Recettes</span>
│   └── 📄 Pain au levain
└── 📄 <span class="t-daily">Daily · 2026-05-26</span></pre>

        <ul class="org-list reveal">
          <li><span class="org-key">Workspaces</span><span class="org-val">Pièces silencieuses. Une par contexte.</span></li>
          <li><span class="org-key">Dossiers</span><span class="org-val">Récursifs, drag &amp; drop.</span></li>
          <li><span class="org-key">Wiki-links</span><span class="org-val"><code>[[Doc]]</code> · complétion en place.</span></li>
          <li><span class="org-key">Transclusion</span><span class="org-val"><code>![[Doc]]</code> · embarque le contenu.</span></li>
          <li><span class="org-key">Daily notes</span><span class="org-val">Un template par jour, prêt à remplir.</span></li>
          <li><span class="org-key">Versions</span><span class="org-val">Snapshot toutes les 30 min d'édition.</span></li>
          <li><span class="org-key">Backlinks</span><span class="org-val">Qui te cite, depuis chaque page.</span></li>
          <li><span class="org-key">Graphe</span><span class="org-val">Vue d'ensemble des liens entre docs.</span></li>
          <li><span class="org-key">Corbeille</span><span class="org-val">Suppression douce. Restauration possible.</span></li>
          <li><span class="org-key">Tags</span><span class="org-val">Extraits par l'IA, navigables.</span></li>
          <li><span class="org-key">Recherche</span><span class="org-val">Hybride sémantique + plein texte.</span></li>
          <li><span class="org-key">Focus mode</span><span class="org-val"><code>Ctrl+.</code> — l'éditeur, et rien d'autre.</span></li>
        </ul>
      </div>
    </section>

    <!-- ═════════════════════════════════════════════════════════════════
         § V — PONTS
         ═════════════════════════════════════════════════════════════════ -->
    <section class="chapter">
      <header class="chapter-header reveal">
        <p class="eyebrow"><span class="section-marker">§ V</span><span>Intégrer</span></p>
        <h2 class="chapter-title">
          <span class="underlined-soft">Branchements</span>.
        </h2>
        <p class="chapter-lede">
          NoteForge n'est pas un silo. Tu importes, tu exportes, et tu le
          branches à Claude Desktop via MCP.
        </p>
      </header>

      <div class="bridges">
        <article class="bridge bridge-mcp reveal">
          <header>
            <p class="card-eyebrow">MCP · Model Context Protocol</p>
            <h3 class="card-title">Claude Desktop, dans tes notes.</h3>
          </header>
          <p class="bridge-body">
            Génère un token, colle la config. Claude lit, écrit, cherche, analyse
            tes documents — chiffrés au repos, déchiffrés à la demande, scopés à ton compte.
          </p>
          <pre class="bridge-code"><span class="hl-c">// claude_desktop_config.json</span>
{
  <span class="hl-a">"mcpServers"</span>: {
    <span class="hl-a">"noteforge"</span>: {
      <span class="hl-a">"url"</span>: <span class="hl-s">"https://…/api/mcp"</span>,
      <span class="hl-a">"headers"</span>: {
        <span class="hl-a">"Authorization"</span>: <span class="hl-s">"Bearer nf_…"</span>
      }
    }
  }
}</pre>
          <ul class="bridge-tools">
            <li><code>list_workspaces</code></li>
            <li><code>search_notes</code></li>
            <li><code>read_document</code></li>
            <li><code>create_document</code></li>
            <li><code>analyze_document</code></li>
            <li><code>+ 6 autres</code></li>
          </ul>
        </article>

        <div class="bridge-stack">
          <article class="bridge bridge-mini reveal">
            <p class="card-eyebrow">Export</p>
            <h4 class="bridge-h">PDF · DOCX · Markdown</h4>
            <p class="bridge-b">Un menu, trois formats, fidèles à ce que tu vois.</p>
          </article>
          <article class="bridge bridge-mini reveal">
            <p class="card-eyebrow">Import</p>
            <h4 class="bridge-h">Glisser un dossier <code>.md</code></h4>
            <p class="bridge-b">L'arborescence est reconstruite. Les liens internes sont résolus.</p>
          </article>
          <article class="bridge bridge-mini reveal">
            <p class="card-eyebrow">Thèmes &amp; langue</p>
            <h4 class="bridge-h">Clair · Sombre · FR · EN</h4>
            <p class="bridge-b">Tout bascule au clic, sans rechargement.</p>
          </article>
          <article class="bridge bridge-mini reveal">
            <p class="card-eyebrow">Partage</p>
            <h4 class="bridge-h">Liens publics révocables</h4>
            <p class="bridge-b">Une page rendue, lisible par n'importe qui — coupable d'un clic.</p>
          </article>
        </div>
      </div>
    </section>

    <!-- ═════════════════════════════════════════════════════════════════
         § FINAL CTA
         ═════════════════════════════════════════════════════════════════ -->
    <section class="finale">
      <div class="finale-card reveal">
        <p class="eyebrow finale-eyebrow">
          <span class="section-marker">§</span><span>Pour commencer</span>
        </p>
        <h2 class="finale-title">
          Ouvre la <span class="underlined">première page</span><span class="finale-period">.</span>
        </h2>
        <p class="finale-lede">
          Création de compte en deux champs. Workspace prêt avec un
          document de bienvenue qui te fait visiter chaque feature.
        </p>
        <div class="finale-cta">
          <NuxtLink to="/register" class="btn btn-primary btn-large">
            <span>Créer un compte</span>
            <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
              <path d="M3 8h10 M9 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </NuxtLink>
          <NuxtLink to="/login" class="btn btn-ghost btn-large">
            <span>J'ai déjà un compte</span>
          </NuxtLink>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
/* ──────────────────────────────────────────────────────────────────────
   GLOBAL — landing chrome
   ────────────────────────────────────────────────────────────────────── */
.landing {
  @apply mx-auto w-full max-w-[1180px] px-5 sm:px-8 md:px-10;
}

/* Eyebrow component used at the top of every section */
.eyebrow {
  @apply flex items-center gap-2 mb-5 label-mono;
  letter-spacing: 0.14em;
}
.section-marker {
  @apply font-serif text-[14px] font-semibold text-ink-900 dark:text-ink-100;
  letter-spacing: 0;
  text-transform: none;
}
.eyebrow-dot { @apply text-ink-300; }
.eyebrow-version {
  @apply font-mono text-[10px];
  letter-spacing: 0.04em;
}

/* Underline used on key phrases — hand-drawn squiggle via SVG mask */
.underlined {
  position: relative;
  display: inline-block;
  color: inherit;
}
.underlined::after {
  content: '';
  position: absolute;
  left: -2%;
  right: -2%;
  bottom: 0.02em;
  height: 0.42em;
  background: theme('colors.accent.300');
  z-index: -1;
  transform: skewY(-1deg);
  border-radius: 2px;
  opacity: 0.65;
}
html.dark .underlined::after {
  background: theme('colors.accent.500');
  opacity: 0.32;
}
.underlined-soft {
  position: relative;
  display: inline-block;
}
.underlined-soft::after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  bottom: -0.06em;
  height: 1px;
  background: theme('colors.accent.500');
}

/* Reveal animation — IO toggles `.is-in` */
.reveal {
  opacity: 0;
  transform: translateY(14px);
  transition: opacity 700ms cubic-bezier(0.2, 0.7, 0.2, 1),
              transform 700ms cubic-bezier(0.2, 0.7, 0.2, 1);
}
.reveal.is-in {
  opacity: 1;
  transform: none;
}
@media (prefers-reduced-motion: reduce) {
  .reveal { opacity: 1; transform: none; transition: none; }
}

/* ──────────────────────────────────────────────────────────────────────
   HERO
   ────────────────────────────────────────────────────────────────────── */
.hero {
  @apply relative pt-10 md:pt-16 pb-14 md:pb-20;
}
.hero-grid {
  @apply grid grid-cols-1 lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-16 items-start;
}

.hero-eyebrow { @apply mb-7; }

.hero-title {
  @apply font-serif text-ink-900 dark:text-ink-100;
  font-size: clamp(2.6rem, 6.4vw, 5rem);
  line-height: 0.98;
  letter-spacing: -0.025em;
  font-weight: 400;
}
.hero-line {
  display: block;
  opacity: 0;
  transform: translateY(12px);
  animation: hero-line-in 800ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
}
.line-1 { animation-delay: 80ms; }
.line-2 { animation-delay: 220ms; font-style: italic; color: theme('colors.ink.700'); }
html.dark .line-2 { color: theme('colors.ink.300'); }
.line-3 { animation-delay: 360ms; }
@keyframes hero-line-in {
  to { opacity: 1; transform: none; }
}
.hero-period {
  color: theme('colors.accent.500');
}

.hero-lede {
  @apply font-serif text-ink-700 dark:text-ink-200 mt-7 max-w-[34ch];
  font-size: 18px;
  line-height: 1.55;
  opacity: 0;
  animation: hero-line-in 800ms 480ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
}
.hero-lede em { font-style: italic; color: theme('colors.accent.700'); }
html.dark .hero-lede em { color: theme('colors.accent.300'); }

.hero-cta {
  @apply flex items-center gap-4 mt-9;
  opacity: 0;
  animation: hero-line-in 800ms 620ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
}

.hero-meta {
  @apply mt-10 flex flex-wrap items-center gap-x-5 gap-y-2 font-sans text-[12px] text-ink-500 dark:text-ink-400;
  opacity: 0;
  animation: hero-line-in 800ms 760ms cubic-bezier(0.2, 0.7, 0.2, 1) forwards;
}
.hero-meta li { @apply inline-flex items-center gap-1.5; }
.m-dot {
  @apply inline-block h-1 w-1 rounded-full bg-accent-500;
}

/* ── Buttons ─────────────────────────────────────────────────────────── */
.btn {
  @apply inline-flex items-center justify-center gap-2 h-11 px-5 rounded font-sans uppercase text-[11px] font-semibold;
  letter-spacing: 0.12em;
  transition: background 140ms ease, color 140ms ease, border-color 140ms ease, transform 80ms ease;
}
.btn-large { @apply h-12 px-7 text-[12px]; }
.btn-primary {
  background: theme('colors.ink.900');
  color: theme('colors.ink.50');
}
.btn-primary:hover {
  background: theme('colors.accent.600');
}
html.dark .btn-primary {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
html.dark .btn-primary:hover {
  background: theme('colors.accent.500');
  color: theme('colors.ink.950');
}
.btn-primary:active { transform: translateY(1px); }

.btn-ghost {
  border: 1px solid theme('colors.ink.300');
  color: theme('colors.ink.800');
  background: transparent;
}
.btn-ghost:hover {
  border-color: theme('colors.ink.900');
  background: theme('colors.ink.100');
}
html.dark .btn-ghost {
  border-color: theme('colors.ink.700');
  color: theme('colors.ink.100');
}
html.dark .btn-ghost:hover {
  border-color: theme('colors.ink.100');
  background: theme('colors.ink.900');
}

/* ── Hero specimen panel ─────────────────────────────────────────────── */
.hero-specimen {
  @apply relative justify-self-center lg:justify-self-end;
  width: 100%;
  max-width: 460px;
  perspective: 1200px;
}
.specimen-frame {
  @apply relative rounded-lg overflow-hidden;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  box-shadow:
    0 1px 0 theme('colors.ink.50'),
    0 18px 48px -16px theme('colors.ink.900' / 18%),
    0 2px 4px theme('colors.ink.900' / 4%);
  transform: rotate(0.4deg);
  transition: transform 800ms cubic-bezier(0.2, 0.7, 0.2, 1);
}
html.dark .specimen-frame {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.700');
  box-shadow:
    0 18px 48px -16px theme('colors.ink.950' / 70%),
    0 2px 4px theme('colors.ink.950' / 40%);
}
.hero-specimen:hover .specimen-frame { transform: rotate(0deg); }

.specimen-bar {
  @apply flex items-center justify-between px-3 py-2 border-b;
  border-color: theme('colors.ink.200');
  background: theme('colors.ink.100' / 60%);
}
html.dark .specimen-bar {
  border-color: theme('colors.ink.800');
  background: theme('colors.ink.950' / 50%);
}
.bar-dots {
  @apply inline-flex items-center gap-1.5;
}
.bar-dots i {
  @apply inline-block h-2 w-2 rounded-full bg-ink-300 dark:bg-ink-700;
}
.bar-title {
  @apply font-mono text-[11px] text-ink-500 dark:text-ink-400;
}
.bar-saving {
  @apply label-mono;
  color: theme('colors.accent.600');
  letter-spacing: 0.06em;
}
html.dark .bar-saving { color: theme('colors.accent.400'); }

.specimen-body {
  @apply px-5 py-4;
  font-family: theme('fontFamily.serif');
}

.spec-row {
  @apply mb-3;
  opacity: 0;
  animation-fill-mode: forwards;
}
.spec-prompt {
  @apply font-mono text-[12px] text-ink-300 dark:text-ink-600 mr-2;
}
.spec-typed {
  @apply font-mono text-[12.5px] text-ink-700 dark:text-ink-300;
}
.spec-row-a { animation: spec-fade 600ms 800ms forwards; }
.spec-row-b { animation: spec-fade 600ms 1500ms forwards; }
.spec-row-c { animation: spec-fade 600ms 2200ms forwards; }
.spec-row-d { animation: spec-fade 600ms 2900ms forwards; }
.spec-row-e { animation: spec-fade 600ms 3600ms forwards; }
.spec-row-f { animation: spec-fade 600ms 4300ms forwards; }
@keyframes spec-fade {
  from { opacity: 0; transform: translateY(2px); }
  to   { opacity: 1; transform: none; }
}

.spec-h {
  @apply font-serif text-[19px] font-semibold leading-tight text-ink-900 dark:text-ink-100;
}
.spec-task {
  @apply inline-flex items-baseline gap-2 font-serif text-[14px] text-ink-700 dark:text-ink-200;
}
.spec-task input { transform: translateY(2px); }
.wikilink {
  color: theme('colors.accent.700');
  font-style: italic;
}
html.dark .wikilink { color: theme('colors.accent.300'); }
.wikilink-rendered {
  color: theme('colors.accent.700');
  border-bottom: 1px dashed theme('colors.accent.400');
  cursor: pointer;
}
html.dark .wikilink-rendered {
  color: theme('colors.accent.300');
  border-bottom-color: theme('colors.accent.700');
}
.spec-math {
  @apply font-serif italic text-[16px] text-ink-900 dark:text-ink-100;
}
.spec-caret-row { height: 1.2em; }
.spec-caret {
  @apply inline-block;
  width: 2px;
  height: 1em;
  background: theme('colors.ink.900');
  animation: caret 1s steps(2) infinite;
  vertical-align: text-bottom;
}
html.dark .spec-caret { background: theme('colors.ink.100'); }
@keyframes caret {
  50% { opacity: 0; }
}

/* Marginalia floating around the specimen */
.margin-note {
  @apply absolute flex items-center gap-1.5 font-sans text-[11.5px] text-ink-500 dark:text-ink-400 italic;
  pointer-events: none;
}
.margin-note code {
  font-style: normal;
  @apply font-mono text-[10.5px] px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-700 dark:text-ink-300;
}
.mn-arrow {
  @apply font-mono not-italic text-accent-500;
}
.margin-note-1 {
  top: -28px;
  left: -10px;
}
.margin-note-2 {
  bottom: -28px;
  right: -10px;
}
@media (max-width: 1023px) {
  .margin-note { display: none; }
}

/* Hero divider with ⌘ glyph (separates hero from § I) */
.hero-rule {
  @apply relative mt-14 md:mt-20 flex items-center justify-center;
}
.hero-rule::before, .hero-rule::after {
  content: '';
  flex: 1;
  height: 1px;
  background: theme('colors.ink.200');
}
html.dark .hero-rule::before, html.dark .hero-rule::after {
  background: theme('colors.ink.800');
}
.rule-glyph {
  @apply mx-4 font-serif text-[16px] text-ink-400 dark:text-ink-600;
}

/* ──────────────────────────────────────────────────────────────────────
   CHAPTERS
   ────────────────────────────────────────────────────────────────────── */
.chapter {
  @apply relative py-20 md:py-28;
  border-bottom: 1px solid theme('colors.ink.200');
}
html.dark .chapter { border-bottom-color: theme('colors.ink.800' / 70%); }
.chapter-alt { background: theme('colors.ink.50' / 0%); }

.chapter-header {
  @apply max-w-[42rem] mb-14;
}
.chapter-title {
  @apply font-serif text-ink-900 dark:text-ink-100;
  font-size: clamp(2rem, 4.4vw, 3.4rem);
  line-height: 1.04;
  letter-spacing: -0.022em;
  font-weight: 400;
  margin-bottom: 1.25rem;
}
.chapter-lede {
  @apply font-serif text-ink-700 dark:text-ink-300;
  font-size: 17px;
  line-height: 1.6;
  max-width: 38rem;
}
.chapter-lede code {
  @apply font-mono text-[14px] px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-800 dark:text-ink-200;
}

/* ──────────────────────────────────────────────────────────────────────
   § I — DOCUMENT SPECIMEN
   ────────────────────────────────────────────────────────────────────── */
.document-specimen {
  @apply relative mt-4 mx-auto max-w-[720px];
}
.doc-paper {
  @apply relative rounded-lg p-8 md:p-12;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  box-shadow:
    0 1px 0 white,
    0 24px 60px -28px theme('colors.ink.900' / 25%);
}
html.dark .doc-paper {
  background: theme('colors.ink.900');
  border-color: theme('colors.ink.800');
  box-shadow: 0 24px 60px -28px theme('colors.ink.950' / 70%);
}

.doc-meta {
  @apply label-mono flex items-center gap-2 mb-4;
}
.doc-meta-dot { color: theme('colors.ink.300'); }

.doc-title {
  @apply font-serif text-ink-900 dark:text-ink-100;
  font-size: 28px;
  line-height: 1.1;
  letter-spacing: -0.015em;
  font-weight: 600;
  margin-bottom: 1.25rem;
}
.doc-p {
  @apply font-serif text-ink-800 dark:text-ink-200 mb-5;
  font-size: 17px;
  line-height: 1.65;
}
.doc-p em { font-style: italic; }
.doc-p strong { font-weight: 600; color: theme('colors.ink.900'); }
html.dark .doc-p strong { color: theme('colors.ink.50'); }

.doc-callout {
  @apply flex gap-3 my-5 rounded p-4;
  border-left: 3px solid theme('colors.accent.500');
  background: theme('colors.accent.50');
}
html.dark .doc-callout {
  background: theme('colors.accent.900' / 18%);
  border-left-color: theme('colors.accent.400');
}
.callout-glyph {
  @apply inline-flex items-center justify-center h-6 w-6 rounded-full font-serif font-bold text-white text-[14px] shrink-0;
  background: theme('colors.accent.500');
}
.callout-title {
  @apply label-mono mb-1;
  color: theme('colors.accent.700');
}
html.dark .callout-title { color: theme('colors.accent.300'); }
.callout-body {
  @apply font-serif text-[15px] text-ink-800 dark:text-ink-200 leading-relaxed;
}

.doc-tasks {
  @apply font-serif text-[16px] text-ink-800 dark:text-ink-200 my-5;
}
.doc-tasks li {
  @apply flex items-baseline gap-2 py-1;
}
.doc-tasks input { transform: translateY(2px); accent-color: theme('colors.accent.600'); }

.doc-code {
  @apply font-mono text-[13px] my-5 px-4 py-3 rounded overflow-x-auto leading-relaxed;
  background: theme('colors.ink.100');
  border: 1px solid theme('colors.ink.200');
  color: theme('colors.ink.800');
}
html.dark .doc-code {
  background: theme('colors.ink.950');
  border-color: theme('colors.ink.800');
  color: theme('colors.ink.200');
}
.hl-c { color: theme('colors.ink.500'); font-style: italic; }
.hl-k { color: theme('colors.accent.700'); }
.hl-v { color: theme('colors.sky.700'); }
.hl-a { color: theme('colors.rose.700'); }
.hl-s { color: theme('colors.emerald.700'); }
html.dark .hl-c { color: theme('colors.ink.400'); }
html.dark .hl-k { color: theme('colors.accent.300'); }
html.dark .hl-v { color: theme('colors.sky.300'); }
html.dark .hl-a { color: theme('colors.rose.300'); }
html.dark .hl-s { color: theme('colors.emerald.300'); }

.doc-math {
  @apply flex items-baseline justify-center gap-2 font-serif text-[20px] my-6 py-4 border-y;
  border-color: theme('colors.ink.200');
  font-style: italic;
}
html.dark .doc-math { border-color: theme('colors.ink.800'); }
.doc-math > span:first-child { font-size: 32px; line-height: 1; }
.math-body sub, .math-body sup { font-style: normal; }

/* Floating bubble menu over the specimen */
.bubble-menu {
  @apply absolute flex items-center gap-1 rounded-md p-1;
  top: 178px;
  left: 50%;
  transform: translateX(-50%) translateY(-100%);
  background: theme('colors.ink.900');
  color: theme('colors.ink.50');
  box-shadow: 0 8px 24px -8px theme('colors.ink.900' / 40%);
  animation: bm-float 4s ease-in-out infinite;
}
html.dark .bubble-menu {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}
@keyframes bm-float {
  0%, 100% { transform: translateX(-50%) translateY(-100%); }
  50%      { transform: translateX(-50%) translateY(calc(-100% - 4px)); }
}
.bm-btn {
  @apply inline-flex items-center justify-center h-7 min-w-[26px] px-1.5 rounded text-[12px];
  background: transparent;
  color: inherit;
}
.bm-btn:hover { background: theme('colors.ink.700'); }
html.dark .bm-btn:hover { background: theme('colors.ink.200'); }
.bm-active { background: theme('colors.accent.600'); }
html.dark .bm-active { background: theme('colors.accent.500'); color: theme('colors.ink.950'); }
.bm-active:hover { background: theme('colors.accent.700'); }
.bm-sep {
  @apply inline-block w-px h-4 mx-1 bg-ink-700;
}
html.dark .bm-sep { background: theme('colors.ink.300'); }

/* ── Shortcut chips ──────────────────────────────────────────────────── */
.shortcut-grid {
  @apply mt-14 grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3;
}
.chip {
  @apply flex items-center gap-3 rounded-md px-3 py-2.5 font-sans text-[13px] text-ink-700 dark:text-ink-200;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  transition: border-color 140ms ease, background 140ms ease, transform 80ms ease;
}
html.dark .chip {
  background: theme('colors.ink.900' / 50%);
  border-color: theme('colors.ink.800');
}
.chip:hover {
  border-color: theme('colors.accent.400');
  background: theme('colors.accent.50' / 50%);
  transform: translateY(-1px);
}
html.dark .chip:hover {
  border-color: theme('colors.accent.500');
  background: theme('colors.accent.900' / 18%);
}
.chip code {
  @apply font-mono text-[11.5px] px-1.5 py-0.5 rounded bg-ink-900 text-ink-50 shrink-0;
}
html.dark .chip code {
  background: theme('colors.ink.100');
  color: theme('colors.ink.900');
}

/* ──────────────────────────────────────────────────────────────────────
   § II — IA
   ────────────────────────────────────────────────────────────────────── */
.ai-grid {
  @apply grid grid-cols-1 md:grid-cols-2 gap-6 mt-4;
}
.ai-card {
  @apply rounded-lg p-7;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  transition: border-color 200ms ease;
}
html.dark .ai-card {
  background: theme('colors.ink.900' / 50%);
  border-color: theme('colors.ink.800');
}
.ai-card:hover { border-color: theme('colors.ink.400'); }
html.dark .ai-card:hover { border-color: theme('colors.ink.600'); }

.card-eyebrow {
  @apply label-mono mb-3;
}
.card-title {
  @apply font-serif text-ink-900 dark:text-ink-100 mb-5;
  font-size: 22px;
  line-height: 1.2;
  letter-spacing: -0.015em;
  font-weight: 600;
}
.card-list, .card-pipeline {
  @apply font-sans text-[14px] text-ink-700 dark:text-ink-200 leading-relaxed flex flex-col gap-2;
}
.card-list li, .card-pipeline li { @apply flex items-baseline gap-2; }
.bullet { color: theme('colors.accent.500'); font-family: theme('fontFamily.mono'); }
.card-pipeline b { color: theme('colors.accent.600'); font-weight: 600; font-family: theme('fontFamily.mono'); font-size: 12px; }
.card-list code, .card-pipeline code {
  @apply font-mono text-[12px] px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-800 dark:text-ink-200;
}

/* Pipeline diagram */
.pipeline {
  @apply mt-10 mx-auto max-w-[880px];
  color: theme('colors.ink.400');
}
html.dark .pipeline { color: theme('colors.ink.500'); }
.pipeline-svg {
  width: 100%;
  height: auto;
  display: block;
}
.pl-box rect {
  fill: theme('colors.ink.50');
  stroke: theme('colors.ink.300');
  stroke-width: 1;
}
html.dark .pl-box rect {
  fill: theme('colors.ink.900');
  stroke: theme('colors.ink.700');
}
.pl-label {
  font-family: 'Inter', sans-serif;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  fill: theme('colors.ink.900');
}
html.dark .pl-label { fill: theme('colors.ink.100'); }
.pl-sub {
  font-family: ui-monospace, monospace;
  font-size: 9.5px;
  fill: theme('colors.ink.500');
}
html.dark .pl-sub { fill: theme('colors.ink.400'); }
.pl-edges { color: theme('colors.ink.400'); }
html.dark .pl-edges { color: theme('colors.ink.500'); }
.pl-dot { color: theme('colors.accent.500'); }
.pl-dot-2 { color: theme('colors.accent.400'); opacity: 0.7; }

.pipeline-cap {
  @apply mt-3 text-center font-sans text-[11.5px] text-ink-500 dark:text-ink-400 italic;
}

/* Faux chat exchange */
.chat-specimen {
  @apply mt-12 mx-auto max-w-[680px] rounded-lg p-6 md:p-7;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
}
html.dark .chat-specimen {
  background: theme('colors.ink.900' / 60%);
  border-color: theme('colors.ink.800');
}
.chat-msg { @apply mb-5 last:mb-0; }
.msg-label {
  @apply label-mono inline-block mb-1.5;
  letter-spacing: 0.14em;
}
.chat-msg-ai .msg-label { color: theme('colors.accent.600'); }
html.dark .chat-msg-ai .msg-label { color: theme('colors.accent.400'); }
.chat-msg p {
  @apply font-serif text-[16px] text-ink-800 dark:text-ink-200 leading-relaxed;
}
.chat-msg p em { font-style: italic; }
.chat-msg p strong { font-weight: 600; color: theme('colors.ink.900'); }
html.dark .chat-msg p strong { color: theme('colors.ink.50'); }
.citation {
  @apply inline-block font-mono text-[10.5px] px-1.5 py-0.5 rounded-sm mx-0.5 cursor-pointer;
  background: theme('colors.accent.100');
  color: theme('colors.accent.800');
  border: 1px solid theme('colors.accent.200');
  vertical-align: 2px;
  transition: background 120ms ease, transform 80ms ease;
}
html.dark .citation {
  background: theme('colors.accent.900' / 35%);
  color: theme('colors.accent.200');
  border-color: theme('colors.accent.700');
}
.citation:hover { background: theme('colors.accent.500'); color: white; transform: translateY(-1px); }

.chat-sources {
  @apply mt-4 flex flex-col gap-2 pt-4 border-t;
  border-color: theme('colors.ink.200');
}
html.dark .chat-sources { border-color: theme('colors.ink.800'); }
.chat-sources li {
  @apply flex items-baseline gap-3 font-sans text-[12.5px];
}
.src-num {
  @apply font-mono text-[10.5px] px-1.5 py-0.5 rounded bg-ink-900 text-ink-50;
  letter-spacing: 0.02em;
}
html.dark .src-num { background: theme('colors.ink.100'); color: theme('colors.ink.900'); }
.src-title { @apply text-ink-800 dark:text-ink-200 font-semibold; }
.src-snippet { @apply text-ink-500 dark:text-ink-400 italic font-serif truncate; }

/* ──────────────────────────────────────────────────────────────────────
   § III — VAULT (encryption)
   ────────────────────────────────────────────────────────────────────── */
.vault {
  @apply max-w-[640px] mx-auto rounded-lg p-7 md:p-9 flex flex-col items-center;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
}
html.dark .vault {
  background: theme('colors.ink.900' / 60%);
  border-color: theme('colors.ink.800');
}
.vault-row { @apply flex items-baseline gap-3 w-full; }
.vault-label {
  @apply label-mono shrink-0 w-16;
  letter-spacing: 0.1em;
}
.vault-plain {
  @apply font-serif text-[17px] text-ink-900 dark:text-ink-100 italic;
}

.vault-arrow {
  @apply flex flex-col items-center my-3 text-ink-400 dark:text-ink-600;
}
.vault-arrow-label {
  @apply label-mono mt-1;
  letter-spacing: 0.1em;
}

.vault-row-cipher {
  @apply mt-1;
}
.vault-cipher {
  @apply font-mono text-[12.5px] leading-relaxed break-all rounded px-3 py-3 w-full;
  background: theme('colors.ink.100');
  border: 1px solid theme('colors.ink.200');
}
html.dark .vault-cipher {
  background: theme('colors.ink.950');
  border-color: theme('colors.ink.800');
}
.cipher-iv { color: theme('colors.accent.700'); }
html.dark .cipher-iv { color: theme('colors.accent.300'); }
.cipher-tag { color: theme('colors.sky.700'); }
html.dark .cipher-tag { color: theme('colors.sky.300'); }
.cipher-ct { color: theme('colors.ink.500'); }
html.dark .cipher-ct { color: theme('colors.ink.500'); }

.vault-legend {
  @apply mt-4 flex flex-wrap items-center gap-4 font-sans text-[11.5px] text-ink-500 dark:text-ink-400;
}
.lg {
  @apply inline-block h-2 w-2 rounded-sm mr-1.5 align-middle;
}
.lg-iv { background: theme('colors.accent.500'); }
.lg-tag { background: theme('colors.sky.500'); }
.lg-ct { background: theme('colors.ink.400'); }

.pillars {
  @apply mt-12 grid grid-cols-1 md:grid-cols-3 gap-5;
}
.pillars li {
  @apply rounded-lg p-6;
  background: transparent;
  border: 1px solid theme('colors.ink.200');
}
html.dark .pillars li { border-color: theme('colors.ink.800'); }
.pillar-num {
  @apply font-mono text-[11px] text-accent-600 mb-3;
  letter-spacing: 0.1em;
}
.pillar-h {
  @apply font-serif text-[18px] text-ink-900 dark:text-ink-100 mb-2;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.pillar-b {
  @apply font-sans text-[13.5px] text-ink-600 dark:text-ink-300 leading-relaxed;
}
.pillar-b code {
  @apply font-mono text-[12px] px-1 rounded bg-ink-100 dark:bg-ink-800;
}

/* ──────────────────────────────────────────────────────────────────────
   § IV — ATELIER
   ────────────────────────────────────────────────────────────────────── */
.atelier-grid {
  @apply grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-10;
}
.tree-specimen {
  @apply font-mono text-[12.5px] leading-[1.85] text-ink-700 dark:text-ink-300 rounded-lg p-6 whitespace-pre overflow-x-auto;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
}
html.dark .tree-specimen {
  background: theme('colors.ink.900' / 60%);
  border-color: theme('colors.ink.800');
}
.t-ws { color: theme('colors.ink.900'); font-weight: 600; }
html.dark .t-ws { color: theme('colors.ink.50'); }
.t-folder { color: theme('colors.ink.800'); font-weight: 600; }
html.dark .t-folder { color: theme('colors.ink.100'); }
.t-link { color: theme('colors.accent.700'); font-style: italic; }
html.dark .t-link { color: theme('colors.accent.300'); }
.t-back { color: theme('colors.ink.400'); font-style: italic; }
.t-daily { color: theme('colors.sky.700'); }
html.dark .t-daily { color: theme('colors.sky.300'); }

.org-list {
  @apply font-sans;
}
.org-list li {
  @apply flex items-baseline gap-4 py-3 border-b border-ink-200 dark:border-ink-800;
}
.org-list li:last-child { border-bottom: 0; }
.org-key {
  @apply label-mono shrink-0;
  width: 110px;
  letter-spacing: 0.08em;
  color: theme('colors.ink.900');
}
html.dark .org-key { color: theme('colors.ink.100'); }
.org-val {
  @apply text-[13.5px] text-ink-600 dark:text-ink-300;
}
.org-val code {
  @apply font-mono text-[12px] px-1 py-0.5 rounded bg-ink-100 dark:bg-ink-800 text-ink-800 dark:text-ink-200;
}

/* ──────────────────────────────────────────────────────────────────────
   § V — BRIDGES
   ────────────────────────────────────────────────────────────────────── */
.bridges {
  @apply grid grid-cols-1 lg:grid-cols-[1.35fr_1fr] gap-6 items-start;
}
.bridge {
  @apply rounded-lg p-7;
  background: theme('colors.ink.50');
  border: 1px solid theme('colors.ink.200');
  transition: border-color 200ms ease;
}
html.dark .bridge {
  background: theme('colors.ink.900' / 50%);
  border-color: theme('colors.ink.800');
}
.bridge:hover { border-color: theme('colors.ink.400'); }
html.dark .bridge:hover { border-color: theme('colors.ink.600'); }

.bridge-mcp {
  @apply p-8;
}
.bridge-body {
  @apply font-serif text-[15px] text-ink-700 dark:text-ink-200 my-4 leading-relaxed;
}
.bridge-code {
  @apply font-mono text-[12.5px] my-4 px-4 py-3 rounded overflow-x-auto leading-relaxed;
  background: theme('colors.ink.950');
  color: theme('colors.ink.200');
}
.bridge-code .hl-c { color: theme('colors.ink.400'); }
.bridge-code .hl-a { color: theme('colors.rose.300'); }
.bridge-code .hl-s { color: theme('colors.emerald.300'); }

.bridge-tools {
  @apply flex flex-wrap gap-1.5 mt-4;
}
.bridge-tools li code {
  @apply font-mono text-[11px] px-2 py-1 rounded bg-ink-100 dark:bg-ink-800 text-ink-800 dark:text-ink-200;
}

.bridge-stack {
  @apply grid grid-cols-1 sm:grid-cols-2 gap-4;
}
.bridge-mini {
  @apply p-5;
}
.bridge-h {
  @apply font-serif text-[16px] text-ink-900 dark:text-ink-100 mb-1.5;
  font-weight: 600;
}
.bridge-h code {
  @apply font-mono text-[12.5px] px-1 rounded bg-ink-100 dark:bg-ink-800;
}
.bridge-b {
  @apply font-sans text-[13px] text-ink-600 dark:text-ink-300 leading-relaxed;
}

/* ──────────────────────────────────────────────────────────────────────
   FINALE
   ────────────────────────────────────────────────────────────────────── */
.finale {
  @apply py-20 md:py-28;
}
.finale-card {
  @apply max-w-[640px] mx-auto text-center;
}
.finale-eyebrow {
  @apply justify-center mb-7;
}
.finale-title {
  @apply font-serif text-ink-900 dark:text-ink-100 mb-5;
  font-size: clamp(2.2rem, 5vw, 3.8rem);
  line-height: 1.04;
  letter-spacing: -0.022em;
  font-weight: 400;
}
.finale-period { color: theme('colors.accent.500'); }
.finale-lede {
  @apply font-serif text-[17px] text-ink-700 dark:text-ink-300 mb-9 leading-relaxed max-w-[36rem] mx-auto;
}
.finale-cta {
  @apply flex flex-wrap items-center justify-center gap-4;
}

/* ──────────────────────────────────────────────────────────────────────
   RESPONSIVE TIGHTENING
   ────────────────────────────────────────────────────────────────────── */
@media (max-width: 768px) {
  .hero { @apply pt-6 pb-10; }
  .hero-grid { gap: 3rem; }
  .chapter { @apply py-14; }
  .doc-paper { @apply p-6; }
  .bubble-menu { display: none; }
  .bridge-mcp { @apply p-6; }
}
</style>
