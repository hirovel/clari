#!/usr/bin/env bash
# 把本地主分支整理成公开分支并推送:剔除内部文档(docs/),保留提交历史与日期。
# 用法:bash scripts/publish-public.sh [远程名=origin] [远程分支=main]
set -euo pipefail
remote="${1:-origin}"
branch="${2:-main}"
src="$(git rev-parse --abbrev-ref HEAD)"

git branch -f public "$src"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --prune-empty \
  --index-filter 'git rm -r --cached --ignore-unmatch --quiet docs' \
  -- public
# 公开历史应在上次发布之后继续;远端有新提交或过滤规则改变时停止,不覆盖远端历史。
git push "$remote" "public:$branch"
echo "已推送 $src → $remote/$branch(不含 docs/)"
