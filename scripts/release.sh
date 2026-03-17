#!/usr/bin/env bash
set -euo pipefail

# ── Glissa release script ─────────────────────────────────────
# Publishes to npm, pushes to GitHub, tags, and creates a release.
# Usage: bash scripts/release.sh

VERSION=$(node -p "require('./package.json').version")
TAG="v$VERSION"

echo "==> Releasing glissa $TAG"

# 1. Ensure working tree is clean
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: Working tree is dirty. Commit or stash changes first."
  exit 1
fi

# 2. Build and verify dist
echo "==> Building..."
npm run build
node -e "require('fs').statSync('dist/index.html')"

# 3. Publish to npm
echo "==> Publishing to npm..."
npm publish

# 4. Push commits to GitHub
echo "==> Pushing to GitHub..."
git push

# 5. Tag and push tag
echo "==> Tagging $TAG..."
git tag "$TAG"
git push origin "$TAG"

# 6. Create GitHub release from CHANGELOG
echo "==> Creating GitHub release..."
# Extract the current version's changelog section
NOTES=$(awk "/^## \[$VERSION\]/{found=1; next} /^## \[/{if(found) exit} found{print}" CHANGELOG.md)

gh release create "$TAG" \
  --title "Glissa $TAG" \
  --notes "$NOTES"

echo "==> Done! Published glissa@$VERSION to npm and GitHub."
