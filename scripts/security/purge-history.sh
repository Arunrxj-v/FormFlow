#!/usr/bin/env bash
# FormFlow history-purge helper.
#
# This script is intentionally NOT run automatically. The repository contains
# personal identity documents in reachable Git history and on a PUBLIC remote.
# Rewriting history and force-pushing is destructive and must be coordinated by
# the repository owner.
#
# Prerequisites:
#   - git-filter-repo installed (https://github.com/newren/git-filter-repo)
#   - a complete backup/mirror clone of the repository
#   - every collaborator has stopped pushing
#   - the owner has rotated any credentials that may have been exposed
#
# Usage:
#   FORMFLOW_CONFIRM_HISTORY_REWRITE=YES ./scripts/security/purge-history.sh
#
# After this script runs locally, force-push every affected branch/tag and ask
# GitHub Support to purge cached views/forks if the repository was public.

set -euo pipefail

if [[ "${FORMFLOW_CONFIRM_HISTORY_REWRITE:-}" != "YES" ]]; then
  echo "Refusing to rewrite history. Set FORMFLOW_CONFIRM_HISTORY_REWRITE=YES after reading docs/FORMFLOW_SECURITY_HARDENING.md." >&2
  exit 1
fi

if ! command -v git-filter-repo >/dev/null 2>&1; then
  echo "git-filter-repo is required." >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean. Commit or preserve changes before rewriting history." >&2
  exit 1
fi

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

echo "Creating a local backup mirror in ../FormFlow-pre-purge.git"
git clone --mirror . ../FormFlow-pre-purge.git

echo "Removing server/storage/documents from all reachable history..."
git filter-repo --force --invert-paths --path server/storage/documents

echo
echo "Local history rewritten. Verify before pushing:"
echo "  git ls-files server/storage"
echo "  git log --all --oneline -- server/storage/documents"
echo "  git fsck --full"
echo
echo "Then force-push every affected branch and tag, for example:"
echo "  git push --force --all origin"
echo "  git push --force --tags origin"
echo
echo "Because the remote was public, also:"
echo "  1. Ask GitHub Support to purge cached views and forks."
echo "  2. Treat the exposed identity document as compromised and follow the"
echo "     document issuer's replacement/rotation process."
echo "  3. Invalidate old clones and CI caches."
