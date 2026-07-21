#!/usr/bin/env bash
#
# dist.sh — build the distributable zip.
#
#   pnpm run dist
#
# Order matters: every check runs BEFORE anything is packaged, so a failed check
# means no zip exists to accidentally send to anyone.

set -uo pipefail

cd "$(dirname "$0")/.."

APP_SLUG="cinematic-workflow"
OUT_DIR="dist"
ZIP_PATH="${OUT_DIR}/${APP_SLUG}.zip"

step() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
die()  { printf '\n\033[31m%s\033[0m\n' "$1"; exit 1; }

# ---------------------------------------------------------------------------
step '1/4  Preflight'
# ---------------------------------------------------------------------------
bash scripts/preflight.sh || die "Preflight failed — no zip built. (That is the point.)"

# ---------------------------------------------------------------------------
step '2/4  Verify migrations apply to a throwaway database'
# ---------------------------------------------------------------------------
# A zip is only deployable if `supabase db push` works on a project that has
# never seen this app. `supabase db reset` proves exactly that: it drops the
# local database and replays every migration from empty.
#
# Needs Docker running (Colima is fine). If Docker is unavailable we do NOT
# silently skip and ship anyway — an unverified migration is the single thing
# most likely to make a distributor's deploy fail on step one.

if ! command -v supabase >/dev/null 2>&1; then
  die "supabase CLI not found. Install it: brew install supabase/tap/supabase"
fi

if ! docker info >/dev/null 2>&1; then
  die "Docker is not running, so migrations cannot be verified — refusing to build.
       Start it (colima start) and re-run. To ship without this check you would
       have to edit this script, which is deliberately harder than fixing Docker."
fi

if ! supabase status >/dev/null 2>&1; then
  printf 'Local Supabase stack is not running; starting it...\n'
  supabase start -x imgproxy,studio,logflare,vector,supavisor,mailpit \
    || die "Could not start the local Supabase stack."
fi

supabase db reset || die "Migrations failed to apply to an empty database — no zip built."
printf 'Migrations applied cleanly from empty.\n'

# ---------------------------------------------------------------------------
step '3/4  Package'
# ---------------------------------------------------------------------------
# Exclusions are belt-and-braces: .env.local is already gitignored and preflight
# already checks it, but the zip is the thing that actually leaves the building,
# so it excludes secrets by name too. Step 4 verifies these worked.

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

zip -r -q "$ZIP_PATH" . \
  -x '*.env.local*' \
  -x '.env.local' \
  -x 'TEMPLATE.md' \
  -x 'node_modules/*' \
  -x '.git/*' \
  -x '.next/*' \
  -x 'dist/*' \
  -x 'supabase/.temp/*' \
  -x 'supabase/.branches/*' \
  -x 'tsconfig.tsbuildinfo' \
  -x '*.DS_Store' \
  -x '*.log' \
  || die "zip failed"

# ---------------------------------------------------------------------------
step '4/4  Verify the zip'
# ---------------------------------------------------------------------------
# Trust the artifact, not the intent: read back what is actually inside.

CONTENTS=$(unzip -Z1 "$ZIP_PATH")

if printf '%s\n' "$CONTENTS" | grep -qE '(^|/)\.env\.local$'; then
  rm -f "$ZIP_PATH"
  die "FATAL: .env.local is inside the zip. Zip deleted."
fi
printf '  ok  no .env.local in zip\n'

if printf '%s\n' "$CONTENTS" | grep -qE '(^|/)node_modules/|(^|/)\.git/'; then
  rm -f "$ZIP_PATH"
  die "FATAL: node_modules or .git leaked into the zip. Zip deleted."
fi
printf '  ok  no node_modules / .git in zip\n'

# TEMPLATE.md describes the wider Build & Launch architecture — the hub, the
# shared apps project, the embed-token design. It belongs in the repo but not in
# a distributor's hands.
if printf '%s\n' "$CONTENTS" | grep -qE '(^|/)TEMPLATE\.md$'; then
  rm -f "$ZIP_PATH"
  die "FATAL: internal TEMPLATE.md is inside the zip. Zip deleted."
fi
printf '  ok  no internal TEMPLATE.md in zip\n'

for required in '.env.example' 'README.md' 'supabase/migrations'; do
  if ! printf '%s\n' "$CONTENTS" | grep -q "$required"; then
    rm -f "$ZIP_PATH"
    die "FATAL: zip is missing $required — it would not be deployable. Zip deleted."
  fi
done
printf '  ok  .env.example, README and migrations are present\n'

SIZE=$(du -h "$ZIP_PATH" | awk '{print $1}')
COUNT=$(printf '%s\n' "$CONTENTS" | wc -l | tr -d ' ')

printf '\n\033[32mBuilt %s (%s, %s files)\033[0m\n' "$ZIP_PATH" "$SIZE" "$COUNT"
