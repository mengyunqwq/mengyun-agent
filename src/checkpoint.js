'use strict';

/**
 * 梦云 Agent —— git 检查点（改动前自动打点，崩了能回去）
 *
 * 为什么需要它：agent 直接改用户的文件，写坏了只能靠编辑器撤销或 git 手动恢复，
 * 而「刚才 agent 那一串改动之前是什么样」并不好找。所以在**动文件之前**记一个点。
 *
 * 四个必须守住的性质（每一条都对应一次踩坑）：
 *
 * 1. **不碰用户的 HEAD / index / 工作区**。
 *    做法：把索引指向一个临时文件（GIT_INDEX_FILE），在那儿 add -A、write-tree、
 *    commit-tree，最后把 commit 挂到隐藏 ref `refs/mya/checkpoints/*`。
 *    用户的 `git status` / `git log` / 暂存区完全不受影响——这不是可选的好习惯，
 *    是底线：如果打个检查点就把用户的工作区搅了，这个功能就是负资产。
 *
 * 2. **包含未跟踪文件**。
 *    所以不用 `git stash create`（它不含未跟踪文件，而 agent 最常干的就是新建文件）。
 *    `git add -A` 会带上未跟踪文件，并且天然尊重 .gitignore。
 *
 * 3. **不要求用户配 user.name / user.email**。
 *    全新机器上 `git commit-tree` 会因为缺身份直接失败，所以要显式给
 *    GIT_AUTHOR_* / GIT_COMMITTER_*。用一次性的身份，不写进用户的 git config。
 *
 * 4. **失败必须安静**。
 *    没装 git、不是仓库、目录太大超时——都返回 { ok:false, reason } 而不是抛异常。
 *    检查点是增强能力，不是依赖；它不该让一次正常的写入失败。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

/** 隐藏 ref 的命名空间（不会出现在用户的分支列表里） */
const REF_PREFIX = 'refs/mya/checkpoints';

/** 单次 git 调用的超时：仓库特别大时宁可放弃打点，也不能把一次写入卡死 */
const GIT_TIMEOUT_MS = 20000;

/** 一次性身份：不污染用户 git config，也不要求他配过 */
const IDENTITY_ENV = {
  GIT_AUTHOR_NAME: 'mya-checkpoint',
  GIT_AUTHOR_EMAIL: 'checkpoint@mya.local',
  GIT_COMMITTER_NAME: 'mya-checkpoint',
  GIT_COMMITTER_EMAIL: 'checkpoint@mya.local',
};

/**
 * 跑一条 git 命令。
 * @returns {{ok:boolean, out:string, err:string, status:number|null, reason?:string}}
 */
function runGit(cwd, args, { env = {}, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  let res;
  try {
    res = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      env: { ...process.env, ...IDENTITY_ENV, ...env },
    });
  } catch (err) {
    // 没装 git 时 spawnSync 会抛 ENOENT（Windows 上是 status null + error）
    return { ok: false, out: '', err: String(err.message || err), status: null, reason: 'no-git' };
  }
  if (res.error) {
    const reason = res.error.code === 'ENOENT' ? 'no-git' : res.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn-failed';
    return { ok: false, out: String(res.stdout || ''), err: String(res.error.message || res.error), status: null, reason };
  }
  const out = String(res.stdout || '');
  const err = String(res.stderr || '');
  return { ok: res.status === 0, out, err, status: res.status, reason: res.status === 0 ? undefined : 'git-failed' };
}

/** 这个目录（或它的上层）是不是 git 工作区 */
function isRepo(cwd) {
  const r = runGit(cwd, ['rev-parse', '--is-inside-work-tree']);
  return !!(r.ok && r.out.trim() === 'true');
}

/** 仓库根目录（检查点都在根上打，避免在子目录里生成互不相认的 ref） */
function repoRoot(cwd) {
  const r = runGit(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? r.out.trim() : '';
}

function hasHead(cwd) {
  const r = runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  return !!(r.ok && r.out.trim());
}

/** 打一个检查点。不抛异常，失败一律 { ok:false, reason } */
function createCheckpoint(cwd, { label = '', sessionId = '' } = {}) {
  if (!cwd || !fs.existsSync(cwd)) return { ok: false, reason: 'no-cwd' };
  if (!isRepo(cwd)) return { ok: false, reason: 'not-a-repo' };
  const root = repoRoot(cwd) || cwd;

  const idxFile = path.join(os.tmpdir(), `mya-ckpt-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const env = { GIT_INDEX_FILE: idxFile };
  try {
    // 索引先对齐 HEAD（没有提交就用空树），否则所有文件都会被当成「新增」，
    // 概览里的改动量会失真
    const base = hasHead(root) ? runGit(root, ['read-tree', 'HEAD'], { env }) : runGit(root, ['read-tree', '--empty'], { env });
    if (!base.ok) return { ok: false, reason: 'read-tree-failed', error: base.err.trim() };

    const added = runGit(root, ['add', '-A'], { env });
    if (!added.ok) return { ok: false, reason: 'add-failed', error: added.err.trim() };

    const tree = runGit(root, ['write-tree'], { env });
    if (!tree.ok) return { ok: false, reason: 'write-tree-failed', error: tree.err.trim() };
    const treeId = tree.out.trim();

    const parent = hasHead(root) ? runGit(root, ['rev-parse', 'HEAD']).out.trim() : '';
    const message = `mya checkpoint${label ? `: ${label}` : ''}${sessionId ? `\n\nsession: ${sessionId}` : ''}`;
    const commitArgs = ['commit-tree', treeId];
    if (parent) commitArgs.push('-p', parent);
    commitArgs.push('-m', message);
    const commit = runGit(root, commitArgs);
    if (!commit.ok) return { ok: false, reason: 'commit-tree-failed', error: commit.err.trim() };
    const commitId = commit.out.trim();

    // ref 名只留数字：ISO 串里的 - : . 都要去掉，否则会得到 "20260929054342.-156b483" 这种别扭名字
    const stamp = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14);
    const ref = `${REF_PREFIX}/${stamp}-${commitId.slice(0, 7)}`;
    const put = runGit(root, ['update-ref', ref, commitId]);
    if (!put.ok) return { ok: false, reason: 'update-ref-failed', error: put.err.trim() };

    // 一行概览：有 parent 就比一下，没有就说文件数
    let summary = '';
    const files = tree.out ? runGit(root, ['ls-tree', '-r', '--name-only', commitId]).out.trim().split('\n').filter(Boolean) : [];
    if (parent) {
      const stat = runGit(root, ['diff', '--shortstat', parent, commitId]);
      summary = stat.ok ? stat.out.trim() : '';
    }
    if (!summary) summary = `${files.length} 个文件`;

    return { ok: true, ref, commit: commitId, tree: treeId, parent: parent || '', files, summary, root };
  } finally {
    try {
      fs.rmSync(idxFile, { force: true });
    } catch {
      /* 临时索引删不掉不影响结果 */
    }
  }
}

/** 列出检查点（新的在前） */
function listCheckpoints(cwd, limit = 20) {
  if (!isRepo(cwd)) return [];
  const root = repoRoot(cwd) || cwd;
  const r = runGit(root, [
    'for-each-ref',
    `--format=%(refname)%09%(objectname)%09%(creatordate:iso-strict)%09%(subject)`,
    REF_PREFIX,
  ]);
  if (!r.ok || !r.out.trim()) return [];
  return r.out
    .trim()
    .split('\n')
    .map((line) => {
      const [ref, commit, at, ...rest] = line.split('\t');
      return { ref, commit, at, label: (rest.join('\t') || '').replace(/^mya checkpoint:?\s*/, '') };
    })
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, Math.max(1, limit));
}

/** 某个检查点里有哪些文件 */
function checkpointFiles(cwd, ref) {
  const root = repoRoot(cwd) || cwd;
  const r = runGit(root, ['ls-tree', '-r', '--name-only', ref]);
  return r.ok ? r.out.trim().split('\n').filter(Boolean) : [];
}

/** 与父提交比，改了什么（给人看的一行/几行概览） */
function checkpointDiff(cwd, ref) {
  const root = repoRoot(cwd) || cwd;
  const parent = runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^`]);
  if (!parent.ok) return { files: checkpointFiles(cwd, ref).map((f) => ({ status: 'A', path: f })), stat: '' };
  const stat = runGit(root, ['diff', '--stat', `${ref}^`, ref]);
  const nameStatus = runGit(root, ['diff', '--name-status', `${ref}^`, ref]);
  const files = nameStatus.ok
    ? nameStatus.out
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [status, ...rest] = l.split('\t');
          return { status, path: rest.join('\t') };
        })
    : [];
  return { files, stat: stat.ok ? stat.out.trim() : '', parent: parent.out.trim() };
}

/**
 * 回滚到某个检查点。
 *
 * 用 `git restore --source=<ref> --staged --worktree` 而不是 `git reset --hard`：
 * reset 会移动用户的 HEAD（等于替他改历史），restore 只动工作区和暂存区的内容。
 * 已知边界（要如实告知）：检查点之后**新建**的文件不会被删掉——
 * restore 只负责把 ref 里存在的路径恢复成当时的样子。
 */
function restoreCheckpoint(cwd, ref) {
  if (!isRepo(cwd)) return { ok: false, reason: 'not-a-repo' };
  const root = repoRoot(cwd) || cwd;
  const exists = runGit(root, ['rev-parse', '--verify', '--quiet', ref]);
  if (!exists.ok) return { ok: false, reason: 'no-such-ref' };

  const before = runGit(root, ['status', '--porcelain']).out.trim();
  let r = runGit(root, ['restore', '--source', ref, '--staged', '--worktree', '--', '.'], { timeoutMs: 60000 });
  if (!r.ok) {
    // 老版本 git 没有 restore（2.23 之前），退回 checkout
    r = runGit(root, ['checkout', ref, '--', '.'], { timeoutMs: 60000 });
  }
  if (!r.ok) return { ok: false, reason: 'restore-failed', error: r.err.trim() };
  const after = runGit(root, ['status', '--porcelain']).out.trim();
  return { ok: true, root, ref, changed: after !== before };
}

/** 只留最近 N 个检查点，旧的删掉（ref 越攒越多会让 for-each-ref 变慢） */
function pruneCheckpoints(cwd, keep = 50) {
  const list = listCheckpoints(cwd, 1000);
  if (list.length <= keep) return 0;
  const root = repoRoot(cwd) || cwd;
  let removed = 0;
  for (const item of list.slice(keep)) {
    const r = runGit(root, ['update-ref', '-d', item.ref]);
    if (r.ok) removed += 1;
  }
  return removed;
}

module.exports = {
  REF_PREFIX,
  isRepo,
  repoRoot,
  createCheckpoint,
  listCheckpoints,
  checkpointFiles,
  checkpointDiff,
  restoreCheckpoint,
  pruneCheckpoints,
  runGit,
};
