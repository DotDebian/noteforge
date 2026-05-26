#!/usr/bin/env bash
# Prépare l'environnement avant `docker compose up -d`.
#
# Idempotent : peut être relancé sans casser un .env existant (demande avant
# d'écraser). Génère un NUXT_SESSION_PASSWORD de 48 octets base64 et prompte
# pour la clé Mistral.
set -euo pipefail

cd "$(dirname "$0")"

# ---- couleurs ------------------------------------------------------------- #
if [ -t 1 ]; then
  C_BOLD=$(printf '\033[1m'); C_DIM=$(printf '\033[2m')
  C_GREEN=$(printf '\033[32m'); C_YELLOW=$(printf '\033[33m')
  C_RED=$(printf '\033[31m'); C_RESET=$(printf '\033[0m')
else
  C_BOLD=""; C_DIM=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_RESET=""
fi

say()  { printf "%s[noteforge]%s %s\n" "$C_BOLD" "$C_RESET" "$*"; }
warn() { printf "%s[noteforge]%s %s%s%s\n" "$C_BOLD" "$C_RESET" "$C_YELLOW" "$*" "$C_RESET"; }
die()  { printf "%s[noteforge]%s %s%s%s\n" "$C_BOLD" "$C_RESET" "$C_RED" "$*" "$C_RESET" >&2; exit 1; }

# ---- prérequis ------------------------------------------------------------ #
command -v docker >/dev/null 2>&1 || die "Docker introuvable — installe Docker Engine puis relance."
docker compose version >/dev/null 2>&1 \
  || die "Plugin 'docker compose' introuvable — installe docker-compose-plugin (ou Docker Desktop)."
command -v openssl >/dev/null 2>&1 || die "openssl requis pour générer la session password."

# ---- .env ----------------------------------------------------------------- #
ENV_FILE=".env"
ENV_EXAMPLE=".env.example"

[ -f "$ENV_EXAMPLE" ] || die "$ENV_EXAMPLE manquant — tu n'es pas dans le repo noteforge ?"

write_env=1
if [ -f "$ENV_FILE" ]; then
  warn "$ENV_FILE existe déjà."
  printf "%sÉcraser ? %s[y/N]%s " "$C_DIM" "$C_BOLD" "$C_RESET"
  read -r answer || answer=""
  case "$answer" in
    y|Y|yes) write_env=1 ;;
    *)       write_env=0; say "$ENV_FILE conservé tel quel." ;;
  esac
fi

if [ "$write_env" -eq 1 ]; then
  say "Génération d'un NUXT_SESSION_PASSWORD (48 octets base64)…"
  session_pwd=$(openssl rand -base64 48 | tr -d '\n')

  printf "%sClé MISTRAL_API_KEY%s (laisser vide pour remplir plus tard) : " "$C_BOLD" "$C_RESET"
  # -s masque la saisie ; certains shells POSIX-only ne le supportent pas, fallback silencieux.
  if read -rs mistral_key 2>/dev/null; then echo; else read -r mistral_key; fi
  mistral_key=${mistral_key:-sk-replace-me}

  umask 077
  cat > "$ENV_FILE" <<EOF
# Généré par setup.sh le $(date -u +%Y-%m-%dT%H:%M:%SZ)
MISTRAL_API_KEY=$mistral_key
MISTRAL_CHAT_MODEL=mistral-large-latest
MISTRAL_EMBED_MODEL=mistral-embed

NUXT_SESSION_PASSWORD=$session_pwd

# Chemin interne au container — ne pas changer sauf si tu déplaces le volume.
DATABASE_URL=/app/data/noteforge.db
EOF
  say "$ENV_FILE écrit (chmod 600)."

  if [ "$mistral_key" = "sk-replace-me" ]; then
    warn "MISTRAL_API_KEY non renseignée — édite $ENV_FILE avant de lancer le container."
  fi
fi

# ---- data/ ---------------------------------------------------------------- #
mkdir -p data
say "Dossier data/ prêt (volume SQLite persistant)."

# ---- récap ---------------------------------------------------------------- #
echo
say "${C_GREEN}Setup terminé.${C_RESET}"
echo
echo "  Étape suivante :"
echo "    ${C_BOLD}docker compose up -d --build${C_RESET}"
echo
echo "  Puis :"
echo "    docker compose logs -f noteforge   # suivi des logs"
echo "    open http://localhost:3000          # crée un compte via /register"
echo
