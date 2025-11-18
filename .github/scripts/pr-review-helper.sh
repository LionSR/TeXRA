#!/bin/bash
# PR Review Helper - Extract and format PR comments

# Usage: ./pr-review-helper.sh [pr-number]
PR_NUMBER=${1:-$(gh pr view --json number -q .number)}

echo "=== PR #$PR_NUMBER Review Comments ==="
echo ""

# Get inline code comments grouped by file
echo "📝 INLINE CODE COMMENTS (by file):"
echo ""
gh api "repos/:owner/:repo/pulls/$PR_NUMBER/comments" --paginate | \
  jq -r 'group_by(.path) | .[] | 
    "FILE: \(.[0].path)\n" + 
    (. | map("  Line \(.line // .original_line): @\(.user.login)\n  \(.body)\n  ---") | join("\n")) + 
    "\n"' | head -200

echo ""
echo "💬 GENERAL PR REVIEWS:"
echo ""
gh pr view "$PR_NUMBER" --json reviews --jq '
  .reviews[] | 
  "👤 \(.author.login) - \(.state)\n\(.body)\n---\n"'

echo ""
echo "🐛 P1 ISSUES ONLY:"
echo ""
gh api "repos/:owner/:repo/pulls/$PR_NUMBER/comments" --paginate | \
  jq -r '.[] | select(.body | contains("P1")) | 
    "📍 \(.path):\(.line // .original_line)\n\(.body)\n---\n"'

echo ""
echo "📊 SUMMARY:"
echo ""
echo "Total inline comments: $(gh api "repos/:owner/:repo/pulls/$PR_NUMBER/comments" --paginate | jq length)"
echo "Total reviews: $(gh pr view "$PR_NUMBER" --json reviews --jq '.reviews | length')"
echo "P1 issues: $(gh api "repos/:owner/:repo/pulls/$PR_NUMBER/comments" --paginate | jq '[.[] | select(.body | contains("P1"))] | length')"
