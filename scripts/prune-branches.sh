#!/usr/bin/env bash
# Delete worktrees and branches (local and on the remote) whose tip commit
# is older than N days.
#
# Usage: scripts/prune-branches.sh [--days N] [--remote NAME] [--keep BRANCH]... [--force] [--yes]
#
#   --days N       age cutoff in days, measured from the branch's last commit (default 3)
#   --remote NAME  remote to prune (default origin)
#   --keep BRANCH  never touch this branch (repeatable)
#   --force        remove worktrees even if they have modified or untracked files
#   --yes          actually delete; without it the script only prints the plan
#
# Never touched: the remote's default branch, main, master, the branch checked
# out where the script runs, and the branch checked out in the primary checkout
# (that one's remote copy is still pruned if old).
set -euo pipefail

days=3 remote=origin force=0 yes=0 keep=""
while [ $# -gt 0 ]; do
  case $1 in
    --days)   days=$2; shift 2 ;;
    --remote) remote=$2; shift 2 ;;
    --keep)   keep="$keep $2"; shift 2 ;;
    --force)  force=1; shift ;;
    --yes)    yes=1; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
case $days in ''|*[!0-9]*) echo "--days must be a whole number" >&2; exit 2 ;; esac

cutoff=$(( $(date +%s) - days * 86400 ))
git fetch --prune --quiet "$remote"

default=$(git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null || true)
default=${default#"$remote"/}
current=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)
primary_path=$(git worktree list --porcelain | awk '/^worktree /{print substr($0, 10); exit}')
primary_branch=$(git -C "$primary_path" symbolic-ref --quiet --short HEAD 2>/dev/null || true)

protected=" main master $default $current $keep "
is_protected() { case $protected in *" $1 "*) return 0 ;; esac; return 1; }
is_old() { [ "$(git log -1 --format=%ct "$1")" -lt "$cutoff" ]; }

worktrees=() local_branches=() remote_branches=()

# Worktrees other than the primary checkout, on an old, unprotected branch.
while IFS=$'\t' read -r path branch; do
  [ "$path" = "$primary_path" ] && continue
  [ "$path" = "$(git rev-parse --show-toplevel)" ] && continue
  ref=${branch:-$(git -C "$path" rev-parse HEAD)}
  if [ -n "$branch" ] && is_protected "$branch"; then continue; fi
  is_old "$ref" && worktrees+=("$path")
done < <(git worktree list --porcelain | awk '
  /^worktree /{ if (p != "") print p "\t" b; p = substr($0, 10); b = "" }
  /^branch /  { b = substr($2, 12) }
  END         { if (p != "") print p "\t" b }')

# Local branches: old, unprotected, and not the primary checkout's branch.
while read -r branch ts; do
  is_protected "$branch" && continue
  [ "$branch" = "$primary_branch" ] && continue
  [ "$ts" -lt "$cutoff" ] && local_branches+=("$branch")
done < <(git for-each-ref --format='%(refname:short) %(committerdate:unix)' refs/heads)

# Remote branches: old and unprotected.
while read -r ref ts; do
  [ "$ref" = "$remote" ] && continue          # the remote's HEAD symref
  branch=${ref#"$remote"/}
  is_protected "$branch" && continue
  [ "$ts" -lt "$cutoff" ] && remote_branches+=("$branch")
done < <(git for-each-ref --format='%(refname:short) %(committerdate:unix)' "refs/remotes/$remote")

echo "Cutoff: last commit before $(date -r "$cutoff" 2>/dev/null || date -d "@$cutoff")"
echo "Protected: $(echo $protected) (local only: ${primary_branch:-none})"
echo; echo "Worktrees to remove (${#worktrees[@]}):";              for x in "${worktrees[@]+"${worktrees[@]}"}"; do echo "  $x"; done
echo; echo "Local branches to delete (${#local_branches[@]}):";    for x in "${local_branches[@]+"${local_branches[@]}"}"; do echo "  $x"; done
echo; echo "Branches to delete on $remote (${#remote_branches[@]}):"; for x in "${remote_branches[@]+"${remote_branches[@]}"}"; do echo "  $x"; done

if [ $yes -eq 0 ]; then
  echo; echo "Dry run. Re-run with --yes to delete."
  exit 0
fi

echo
failed=0
for path in "${worktrees[@]+"${worktrees[@]}"}"; do
  if [ $force -eq 1 ]; then git worktree remove --force --force "$path"
  else git worktree remove "$path"; fi || { failed=1; echo "kept $path (re-run with --force to remove it)"; }
done
git worktree prune

for branch in "${local_branches[@]+"${local_branches[@]}"}"; do
  git branch -D "$branch" || failed=1     # fails if a kept worktree still has it checked out
done

if [ ${#remote_branches[@]} -gt 0 ]; then
  git push "$remote" --delete "${remote_branches[@]}" || failed=1
fi

exit $failed
