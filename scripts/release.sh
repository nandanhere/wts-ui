#!/usr/bin/env bash
set -euo pipefail

branch=$(git branch --show-current)
if [ "$branch" != "main" ]; then
  echo "Releases must be created from main (current branch: ${branch:-detached})." >&2
  exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
  echo "Working tree must be clean before releasing." >&2
  exit 1
fi

git fetch --force --tags origin

if latest=$(git describe --tags --abbrev=0 2>/dev/null); then
  commits_since=$(git rev-list "${latest}..HEAD" --count)
else
  latest="v0.0.0"
  commits_since=$(git rev-list HEAD --count)
fi

if [ "$commits_since" = "0" ]; then
  echo "No changes since ${latest} — nothing to release."
  exit 0
fi

if ! [[ "$latest" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Latest tag is not semantic versioning compatible: $latest" >&2
  exit 1
fi

IFS='.' read -r major minor patch <<< "${latest#v}"
patch=$((patch + 1))
next="v${major}.${minor}.${patch}"

git tag -a "${next}" -m "Release ${next}"
git push origin main "${next}"

echo ""
echo "Released ${next} (${commits_since} commits since ${latest})"
echo "Install:  go install github.com/xrehpicx/wts@latest"
