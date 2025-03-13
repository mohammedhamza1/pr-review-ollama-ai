const { ReviewStats } = require('./stats');
const { GitHubAPI } = require('./github');
const { OllamaAPI } = require('./ollama');
const { REVIEW_CONFIG } = require('./config');
const parseDiff = require('parse-diff');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { minimatch } = require('minimatch');
const filePattern = process.env.FILE_PATTERN;

// Cache for existing comments
let existingCommentsCache = null;

// Function to get existing comments with caching
async function getExistingComments(github, owner, repo, prNumber) {
  if (!existingCommentsCache) {
    existingCommentsCache = await github.getExistingComments(owner, repo, prNumber);
  }
  return existingCommentsCache;
}

// Function to check if a similar comment already exists
function findExistingComment(existingComments, newComment) {
  return existingComments.find(
    (existing) =>
      existing.path === newComment.path &&
      existing.line === newComment.line &&
      existing.body.includes(newComment.message.substring(0, 50)) // Compare first 50 chars to avoid minor differences
  );
}

// Function to merge comments on the same line
function mergeComments(comments) {
  const mergedComments = new Map();

  for (const comment of comments) {
    const key = `${comment.path}:${comment.line}`;
    if (!mergedComments.has(key)) {
      mergedComments.set(key, {
        ...comment,
        body: `${REVIEW_CONFIG.emojis[comment.type] || '💭'} **${comment.type.toUpperCase()}** (${
          comment.severity
        })\n\n${comment.message}`
      });
    } else {
      const existing = mergedComments.get(key);
      existing.body += `\n\n${
        REVIEW_CONFIG.emojis[comment.type] || '💭'
      } **${comment.type.toUpperCase()}** (${comment.severity})\n\n${comment.message}`;
    }
  }

  return Array.from(mergedComments.values());
}

// Function to get changed lines from a chunk with proper line numbers and context
function getChangedLines(chunk) {
  const changedLines = new Map();
  const addedLineNumbers = new Set();
  let position = chunk.newStart;

  // First pass: collect all lines with their proper numbers and mark added lines
  chunk.changes.forEach((change) => {
    if (change.type === 'add' || change.type === 'normal') {
      const lineNum = change.ln || change.ln2;
      if (lineNum) {
        changedLines.set(lineNum, {
          content: change.content,
          type: change.type,
          position: lineNum // Use actual line number as position
        });
        if (change.type === 'add') {
          addedLineNumbers.add(lineNum);
        }
      }
    }
  });

  // Include context lines
  const contextLines = new Map();
  Array.from(addedLineNumbers).forEach((lineNum) => {
    // Include 3 lines before and after each changed line
    for (let i = Math.max(1, lineNum - 3); i <= lineNum + 3; i++) {
      if (changedLines.has(i)) {
        contextLines.set(i, changedLines.get(i));
      }
    }
  });

  return {
    context: contextLines,
    addedLines: Array.from(addedLineNumbers)
  };
}

async function processChunk(chunk, file, github, ollama, stats) {
  const { context, addedLines } = getChangedLines(chunk);
  if (addedLines.length === 0) return;

  // Create a string with line numbers, content, and markers for changed lines
  const contentWithLines = Array.from(context.entries())
    .sort(([a], [b]) => a - b)
    .map(([lineNum, { content, type }]) => {
      const isChanged = type === 'add';
      return `${lineNum}:${isChanged ? ' [CHANGED] ' : ' '}${content.trim()}`;
    })
    .join('\n');

  console.log(`Reviewing ${file.to} with context:\n${contentWithLines}`);
  console.log('Changed lines:', addedLines);

  const reviews = await ollama.reviewCode(contentWithLines, file.to, addedLines);
  console.log('Received reviews:', JSON.stringify(reviews, null, 2));

  const commentsToPost = [];
  for (const review of reviews) {
    if (!review.line || !addedLines.includes(review.line)) {
      console.log(`Skipping review for invalid line number: ${review.line}`);
      continue;
    }

    const lineData = context.get(review.line);
    if (!lineData) {
      console.log(`No context found for line ${review.line}`);
      continue;
    }

    stats.updateStats(review.type, review.severity, review.message, file.to, review.line);
    commentsToPost.push({
      ...review,
      path: file.to,
      line: review.line, // Use the actual line number
      message: review.message
    });
  }

  const mergedComments = mergeComments(commentsToPost);
  const existingComments = await getExistingComments(
    github,
    process.env.GITHUB_REPOSITORY_OWNER,
    process.env.GITHUB_REPOSITORY.split('/')[1],
    process.env.PR_NUMBER
  );

  for (const comment of mergedComments) {
    try {
      const existingComment = findExistingComment(existingComments, comment);
      if (existingComment) {
        console.log(
          `Skipping duplicate comment for ${comment.path}:${comment.line} as it already exists`
        );
        continue;
      }

      console.log(`Creating comment for ${comment.path} at line ${comment.line}:`);
      console.log(`Content at line: ${context.get(comment.line).content}`);

      await github.createReviewComment(
        process.env.GITHUB_REPOSITORY_OWNER,
        process.env.GITHUB_REPOSITORY.split('/')[1],
        process.env.PR_NUMBER,
        process.env.GITHUB_SHA,
        comment.path,
        comment.line,
        comment.body
      );
    } catch (error) {
      console.error(
        `Failed to create review comment for ${comment.path}:${comment.line}:`,
        error.message
      );
    }
  }
}

// Function to handle comment replies
async function handleCommentReply(github, ollama, commentId) {
  try {
    const owner = process.env.GITHUB_REPOSITORY_OWNER;
    const repo = process.env.GITHUB_REPOSITORY.split("/")[1];

    console.log(`Processing reply to comment ID: ${commentId}`);

    // Get the comment thread (original comment + all replies)
    const commentThread = await github.getCommentThread(owner, repo, commentId);
    console.log(`Found ${commentThread.length} comments in thread`);

    // Generate AI response based on the conversation history
    const aiResponse = await ollama.generateCommentResponse(commentThread);
    console.log("Generated AI response");

    // Reply to the comment thread
    await github.replyToComment(
      owner,
      repo,
      process.env.PR_NUMBER,
      commentId,
      aiResponse
    );

    console.log("Successfully replied to comment");
    return true;
  } catch (error) {
    console.error("Error handling comment reply:", error);
    return false;
  }
}

// Function to find review comment by ID in PR comments
async function findReviewCommentById(github, owner, repo, prNumber, commentId) {
  try {
    // First try to get the comment directly
    const comment = await github.getCommentById(owner, repo, commentId);
    if (comment && comment.pull_request_url) {
      return comment;
    }
  } catch (error) {
    console.log(
      `Comment ID ${commentId} is not a review comment, checking for references...`
    );
  }

  // If not found or error, check all PR comments to see if any reference this comment
  const prComments = await github.getExistingComments(owner, repo, prNumber);

  // Check if the comment is in reply to any review comment
  for (const comment of prComments) {
    if (comment.in_reply_to_id === parseInt(commentId)) {
      return comment;
    }
  }

  return null;
}

async function main() {
  try {
    const github = new GitHubAPI(process.env.GITHUB_TOKEN);
    const ollama = new OllamaAPI();
    const stats = new ReviewStats();

    const owner = process.env.GITHUB_REPOSITORY_OWNER;
    const repo = process.env.GITHUB_REPOSITORY.split("/")[1];
    const prNumber = process.env.PR_NUMBER;

    // Check if this is a comment event
    if (process.env.EVENT_NAME === "issue_comment" && process.env.COMMENT_ID) {
      console.log("Processing comment event");
      const commentId = process.env.COMMENT_ID;

      // Get the comment that triggered this event
      const comment = await github.getIssueComment(owner, repo, commentId);
      console.log(`Processing comment from user: ${comment.user.login}`);

      // Skip if the comment is from the bot itself to prevent loops
      if (comment.user.login.includes("github-actions")) {
        console.log(
          "Comment is from the bot itself, skipping to prevent loops"
        );
        return;
      }

      // Check if the comment mentions @ollama
      if (comment.body.includes("@ollama")) {
        console.log("Comment mentions @ollama, processing as a direct request");
        // Handle as a direct request to the bot
        await github.postComment(
          owner,
          repo,
          prNumber,
          `Hello @${comment.user.login}, I'm here to help with code review. Please reply to specific review comments to continue our conversation about that code.`
        );
        return;
      }

      // Get all PR review comments
      const prComments = await github.getExistingComments(
        owner,
        repo,
        prNumber
      );
      console.log(
        `Found ${prComments.length} review comments in PR #${prNumber}`
      );

      // Filter to bot comments only
      const botComments = prComments.filter((c) =>
        c.user.login.includes("github-actions")
      );
      console.log(`Found ${botComments.length} bot comments in PR`);

      if (botComments.length === 0) {
        console.log("No bot comments found in PR, nothing to reply to");
        return;
      }

      // Try to find if this is a reply to a specific review comment
      // First check if the comment has a parent_id which would indicate it's a reply
      let parentCommentId = null;

      // Check if the comment is a reply to another comment
      if (comment.in_reply_to_id) {
        parentCommentId = comment.in_reply_to_id;
        console.log(`Comment is a reply to comment ID: ${parentCommentId}`);
      }

      // If we have a parent comment ID, handle the reply
      if (parentCommentId) {
        // Find the review comment this is replying to
        const reviewComment = await findReviewCommentById(
          github,
          owner,
          repo,
          prNumber,
          parentCommentId
        );

        if (reviewComment) {
          console.log(
            `Found review comment that this is replying to: ${reviewComment.id}`
          );
          await handleCommentReply(github, ollama, reviewComment.id);
          return;
        }
      }

      // If we couldn't find a specific comment being replied to,
      // respond to the most recent bot comment as a fallback
      console.log(
        "No specific review comment found, responding to most recent bot comment"
      );
      const latestBotComment = botComments.sort(
        (a, b) => new Date(b.created_at) - new Date(a.created_at)
      )[0];

      await handleCommentReply(github, ollama, latestBotComment.id);
      console.log("Comment processing completed");
      return;
    }

    // Regular PR review process
    console.log("Starting regular PR review process");
    const baseBranch = process.env.BASE_BRANCH || 'origin/develop';
    const diffOutput = execSync(`git diff ${baseBranch} HEAD`).toString();
    const files = parseDiff(diffOutput);

    const filesToReview = files.filter((file) => file.to && minimatch(file.to, filePattern));

    console.log(`Found ${files.length} changed files`);
    console.log(`Reviewing ${filesToReview.length} TypeScript files`);

    const chunks = filesToReview.flatMap((file) => file.chunks.map((chunk) => ({ chunk, file })));

    const concurrencyLimit = parseInt(
      process.env.CONCURRENCY_LIMIT || REVIEW_CONFIG.concurrencyLimit
    );

    for (let i = 0; i < chunks.length; i += concurrencyLimit) {
      const batch = chunks.slice(i, i + concurrencyLimit);
      await Promise.all(
        batch.map(({ chunk, file }) => processChunk(chunk, file, github, ollama, stats))
      );
    }

    const summary = stats.generateSummary();
    await github.postComment(owner, repo, prNumber, summary);

    console.log('Code review completed successfully');
  } catch (error) {
    console.error('Error in code review process:', error);
    process.exit(1);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('Error in main:', error);
    process.exit(1);
  });
}
