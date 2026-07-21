#!/usr/bin/env bash
#
# preflight.sh — the gate that stands between this repo and a shipped zip.
#
# `pnpm run dist` runs this first and refuses to build if it fails. That is the
# guarantee behind every zip: it is deployable, and it never leaks a secret.
#
# Run it directly any time:  pnpm run preflight
#
# Each check prints PASS or FAIL and explains what to do about a FAIL.
# Exit code 0 = safe to ship. Anything else = do not ship.

set -uo pipefail

cd "$(dirname "$0")/.."

FAILED=0
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$1"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAILED=1; }
info() { printf '        %s\n' "$1"; }
head_() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Where app code lives. Everything else (README, config.toml, this script) is
# documentation or tooling, scanned only by the checks that make sense.
CODE_PATHS="app src lib components public"

# Files we never scan: build output, deps, the developer's real secrets.
PRUNE='-name node_modules -o -name .next -o -name dist -o -name .git -o -name .temp'

# Root-level config files that also carry real hosts and env reads, so they must
# be scanned by the same checks as code. CODE_PATHS covers directories only, so a
# root file is invisible to every check until named here. (middleware.ts and
# instrumentation.ts arrive with dual-mode in Step 4; the guard below tolerates
# their absence and picks them up once they exist.)
CODE_FILES_EXTRA="next.config.mjs middleware.ts instrumentation.ts"

code_files() {
  local p
  for p in $CODE_PATHS; do
    [ -d "$p" ] || continue
    find "$p" \( $PRUNE \) -prune -o -type f -print
  done
  for p in $CODE_FILES_EXTRA; do
    [ -f "$p" ] && echo "$p"
  done
}

# Every file worth scanning for secrets, including config and docs.
all_files() {
  find . \( $PRUNE -o -name '.env.local' -o -name '*.env.local' \) -prune -o -type f \
    \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' -o -name '*.mjs' \
       -o -name '*.html' -o -name '*.sql' -o -name '*.toml' -o -name '*.json' \
       -o -name '*.md' -o -name '*.sh' -o -name '*.yml' -o -name '*.yaml' \) -print
}

printf '\033[1mPreflight — Cinematic Workflow\033[0m\n'

# ---------------------------------------------------------------------------
head_ '1. .env.local is ignored and untracked'
# ---------------------------------------------------------------------------
if [ -f .gitignore ] && grep -qE '^\.env\.local$|^\.env\*\.local$' .gitignore; then
  pass ".env.local is listed in .gitignore"
else
  fail ".env.local is NOT in .gitignore"
  info "Add a line '.env.local' to .gitignore before committing anything."
fi

if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  if git ls-files --error-unmatch .env.local >/dev/null 2>&1; then
    fail ".env.local is TRACKED BY GIT — your keys are in the repo history"
    info "Fix: git rm --cached .env.local && rotate every key it contained."
  else
    pass ".env.local is not tracked by git"
  fi
else
  pass "not a git repo yet — nothing tracked (add .gitignore before 'git init')"
fi

# ---------------------------------------------------------------------------
head_ '2. No secret-shaped strings in the code'
# ---------------------------------------------------------------------------
# Pattern-matching, not proof. It catches the shapes real keys take; still read
# your own diffs.
scan_secret() {
  local label="$1" pattern="$2" hits
  hits=$(all_files | xargs grep -InE "$pattern" 2>/dev/null \
         | grep -v '\.env\.example' \
         | grep -v 'preflight\.sh')
  if [ -n "$hits" ]; then
    fail "$label"
    printf '%s\n' "$hits" | head -5 | sed 's/^/        /'
    return 1
  fi
  return 0
}

SECRETS_OK=1
scan_secret "JWT-shaped token found (eyJ...)"                'eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}' || SECRETS_OK=0
scan_secret "Supabase secret key found (sb_secret_...)"      'sb_secret_[A-Za-z0-9_-]{8,}'               || SECRETS_OK=0
scan_secret "Supabase publishable key found"                 'sb_publishable_[A-Za-z0-9_-]{8,}'          || SECRETS_OK=0
scan_secret "Hardcoded Supabase project URL found"           'https://[a-z0-9]{15,}\.supabase\.(co|in)'  || SECRETS_OK=0
scan_secret "Private key block found"                        '-----BEGIN [A-Z ]*PRIVATE KEY-----'        || SECRETS_OK=0
scan_secret "AWS/R2 access key id found"                     'AKIA[0-9A-Z]{16}'                          || SECRETS_OK=0
scan_secret "Postgres connection string with credentials"    'postgres(ql)?://[^:/@ ]+:[^@ ]+@'          || SECRETS_OK=0

[ "$SECRETS_OK" = 1 ] && pass "no secret-shaped strings found"

# ---------------------------------------------------------------------------
head_ '3. The service role key never reaches the browser'
# ---------------------------------------------------------------------------
# Embedded mode writes cinematic_workflow.profiles under the service role (which
# bypasses RLS) AFTER verifying a hub token — correct on the server, catastrophic
# in the browser. Two leak vectors, both checked:
#   a) renamed with a NEXT_PUBLIC_ prefix (Next.js inlines it into the bundle)
#   b) referenced from a "use client" file (drags it into the bundle)

if all_files | xargs grep -In 'NEXT_PUBLIC_[A-Z_]*SERVICE_ROLE\|NEXT_PUBLIC_[A-Z_]*SECRET\|NEXT_PUBLIC_[A-Z_]*PRIVATE\|NEXT_PUBLIC_R2_' 2>/dev/null \
   | grep -v 'preflight\.sh' | grep -q .; then
  fail "a secret-named variable carries a NEXT_PUBLIC_ prefix"
  info "NEXT_PUBLIC_ variables are compiled into the browser bundle. Rename it."
else
  pass "no secret-named variable is exposed via NEXT_PUBLIC_"
fi

SERVER_ONLY_MODULES='env\.server|supabase/admin|lib/user'
CLIENT_LEAK=""
for f in $(code_files | grep -E '\.(ts|tsx|js|jsx)$'); do
  if head -5 "$f" | grep -q "['\"]use client['\"]"; then
    if grep -qE 'process\.env\.(SUPABASE_SERVICE_ROLE_KEY|HUB_PUBLIC_KEY|R2_[A-Z_]+)' "$f" \
       || grep -qE "from ['\"][^'\"]*(${SERVER_ONLY_MODULES})['\"]" "$f"; then
      CLIENT_LEAK="$CLIENT_LEAK $f"
    fi
  fi
done
if [ -n "$CLIENT_LEAK" ]; then
  fail "server-only env vars referenced inside a 'use client' file:$CLIENT_LEAK"
  info "Move that code to a server component, a route handler, or a server action."
else
  pass "no server-only env var is referenced from client code"
fi

# ---------------------------------------------------------------------------
head_ '4. No hardcoded hosts outside the allowlist'
# ---------------------------------------------------------------------------
# Law 1 of the golden template: no domain or provider string in code. This app
# has NO pinned CDN dependencies — everything (Supabase, Cloudflare R2) is
# reached through env-supplied values. So the allowlist is only local-dev hosts.
# If you ever need to add one, add it here WITH a written reason, or it is just a
# disabled check.
#
# drive.google.com / www.dropbox.com / dl.dropboxusercontent.com: fixed public
# video hosts the "Link External Video" feature rewrites into direct-stream URLs
# (getStreamUrl in components/Workspace.tsx). These are third-party consumer
# services with stable public hostnames, not configurable infrastructure — there
# is nothing to move into an env var. Drop them here only if that feature is cut.
ALLOWED_HOSTS='localhost|127\.0\.0\.1|drive\.google\.com|www\.dropbox\.com|dl\.dropboxusercontent\.com'

BAD_HOSTS=$(code_files | xargs grep -IoE 'https?://[A-Za-z0-9._-]+' 2>/dev/null \
            | sed 's|.*https\{0,1\}://||' \
            | grep -vE "^($ALLOWED_HOSTS)$" \
            | sort -u)
if [ -n "$BAD_HOSTS" ]; then
  fail "hardcoded host(s) in code that are not on the allowlist:"
  printf '%s\n' "$BAD_HOSTS" | sed 's/^/        /'
  info "Move it to an env var (Supabase URL, R2 domain), or add it to"
  info "ALLOWED_HOSTS with a written reason."
else
  pass "no hardcoded hosts in code (all endpoints come from env)"
fi

# ---------------------------------------------------------------------------
head_ '5. .env.example documents every variable the code reads'
# ---------------------------------------------------------------------------
if [ ! -f .env.example ]; then
  fail ".env.example is missing"
else
  USED=$(code_files | xargs grep -IohE 'process\.env\.[A-Z0-9_]+' 2>/dev/null \
         | sed 's/process\.env\.//' | sort -u | grep -vE '^(NODE_ENV|NEXT_RUNTIME|VERCEL_.*)$')
  MISSING=""
  for v in $USED; do
    grep -qE "^${v}=" .env.example || MISSING="$MISSING $v"
  done
  if [ -n "$MISSING" ]; then
    fail ".env.example is missing variable(s) the code reads:$MISSING"
    info "Add each with a blank value and a comment saying where to get it."
  else
    pass "every process.env var the code reads is documented in .env.example"
  fi

  # Values must be blank. The one non-secret default the app ships with is the
  # run mode.
  FILLED=$(grep -E '^[A-Z0-9_]+=.+' .env.example | grep -vE '^NEXT_PUBLIC_APP_MODE=standalone$' || true)
  if [ -n "$FILLED" ]; then
    fail ".env.example contains non-blank value(s) — it must never hold real data:"
    printf '%s\n' "$FILLED" | sed 's/^/        /'
  else
    pass ".env.example values are blank"
  fi
fi

# ---------------------------------------------------------------------------
head_ '6. No leftover ERP references (the extraction is complete)'
# ---------------------------------------------------------------------------
# This app was carved out of the Caparison ERP. "Done extracting" means it boots
# and works with ZERO reference to the ERP — its old table names, its shared
# buckets, its role ACL, the cut AI-QC pipeline, or its brand/host strings. Any
# of these in CODE means a coupling survived the port. (Migrations are not scanned
# here: their extraction-notes comments legitimately mention the old names to
# explain what changed.)
ERP_RESIDUE='dcc_cinematic|dcc_share_links|dcc_video_review|dcc_subtasks|has_cinematic_access|trophyLogic|TrophyLogic|checkCinematicVisionary|review-attachments|storage\.from\(.notices.|trigger-ai-qc|qc_status|qc_progress|qc_logs|caparison|portal\.caparisonsoft|pub-b0d2a1e7468748f986633d010e513937'

RESIDUE_HITS=$(code_files | xargs grep -InE "$ERP_RESIDUE" 2>/dev/null)
if [ -n "$RESIDUE_HITS" ]; then
  fail "ERP references still present in app code:"
  printf '%s\n' "$RESIDUE_HITS" | head -10 | sed 's/^/        /'
  info "The extraction is not complete while any of these remain. Remove the"
  info "coupling (rename the table, drop the AI-QC path, env-ify the host)."
else
  pass "no ERP table names, buckets, ACL flags, AI-QC or brand strings in code"
fi

# ---------------------------------------------------------------------------
head_ '7. The CSP does not break the browser runtime'
# ---------------------------------------------------------------------------
# This app deliberately sets NO resource CSP (see next.config.mjs): video streams
# from a BYOK R2 domain unknown at build time, and the workspace hands blob: URLs
# to fetch for thumbnails/uploads. The only directive emitted is frame-ancestors
# (embedded mode). This check is the tripwire for a future regression: IF someone
# adds a connect-src, and the app still creates blob: URLs, blob: must be in it —
# otherwise thumbnail/upload fetches die with a bare "Failed to fetch".
CSP_SRC="next.config.mjs"
if [ ! -f "$CSP_SRC" ] || ! grep -q "Content-Security-Policy" "$CSP_SRC"; then
  pass "no CSP defined — the browser runtime is unrestricted (as it was originally)"
else
  CSP_CONNECT=$(grep -oE '"connect-src [^"]*"' "$CSP_SRC" | head -1)
  BLOB_USERS=$(code_files | xargs grep -l "createObjectURL" 2>/dev/null | tr '\n' ' ')
  if [ -z "$CSP_CONNECT" ]; then
    pass "no connect-src directive — nothing restricts blob:/R2/Supabase fetches"
  elif [ -z "$BLOB_USERS" ]; then
    pass "connect-src present; the app creates no blob: URLs"
  elif printf '%s' "$CSP_CONNECT" | grep -q 'blob:'; then
    pass "connect-src allows blob: (required — the app fetches object URLs)"
  else
    fail "connect-src is MISSING blob:, but the app hands blob: URLs to fetch"
    info "Files using createObjectURL:$BLOB_USERS"
    info "Symptom if shipped: thumbnails/uploads die with a bare \"Failed to fetch\"."
    info "Fix: add blob: to the connect-src directive in $CSP_SRC (and the R2"
    info "public origin to media-src/img-src)."
  fi
fi

# ---------------------------------------------------------------------------
printf '\n'
if [ "$FAILED" = 0 ]; then
  printf '\033[32m%s\033[0m\n' "Preflight passed — safe to ship."
  exit 0
else
  printf '\033[31m%s\033[0m\n' "Preflight FAILED — no zip will be built. Fix the items above."
  exit 1
fi
