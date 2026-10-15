# git 检查点：agent 动文件之前自动打一个点

agent 直接改你的文件。写坏了怎么办？以前只能靠编辑器撤销，或者自己去翻 git——
而「刚才 agent 那一串改动之前是什么样」并不好找。现在每次动文件之前都会记一个点，
一条命令就能回到那时候。

## 怎么用

```bash
mya checkpoint list                    # 看有哪些检查点（新的在前）
mya checkpoint show 3f2a91c            # 这个点改了哪些文件（M/A/D + 一行统计）
mya checkpoint restore 3f2a91c --yes   # 回到那个点
mya checkpoint create "改之前"          # 手动打一个（比如你准备让它大改之前）
```

界面上也直接能点：对话里会出现一块

```
已记录检查点 3f2a91c   1 file changed, 1 insertion(+)   [ 看改动 ]  [ 回滚到这一步 ]
```

- **看改动** → 列出这个点改了哪些文件（新增/修改/删除 + 统计）
- **回滚到这一步** → 先弹确认（说明会覆盖工作区、未保存改动会丢），确认后恢复
- 工具结果里也会带一行 `（已记录检查点 3f2a91c，可用 mya checkpoint restore … 回滚）`

对应的 HTTP 接口（界面用的就是它们）：`GET /api/checkpoints`、`POST /api/checkpoint/create`、
`POST /api/checkpoint/diff`、`POST /api/checkpoint/restore`。回滚接口**只接受本工具创建的
检查点**（ref 必须在 `refs/mya/checkpoints/` 下，且属于当前工作区）——否则它就变成了
"把工作区 checkout 到任意提交"的入口。

## 它到底做了什么

在**你的仓库**里，用独立索引做一次提交，然后挂到隐藏 ref 上：

```
refs/mya/checkpoints/20260929134818-820d478
```

技术上就是三步（都通过 `GIT_INDEX_FILE` 指向临时文件完成）：

1. `git read-tree HEAD` —— 拿当前提交预填临时索引（否则所有文件都会被当成新增，概览失真）
2. `git add -A` —— 把工作区现状（含未跟踪文件、尊重 `.gitignore`）写进临时索引
3. `git write-tree` + `git commit-tree` + `git update-ref` —— 生成提交并挂到隐藏 ref

## 四条硬约束（每条都对应一次踩坑）

| 约束 | 为什么 |
|---|---|
| **不碰 HEAD / 暂存区 / 工作区** | 打个检查点就把用户的工作区搅了，这个功能就是负资产。用临时索引 + 隐藏 ref 才能做到「打完点，`git status` 一模一样」 |
| **包含未跟踪文件** | agent 最常干的就是新建文件。所以**不用** `git stash create`（它不含未跟踪文件），而用 `add -A` |
| **不要求用户配 user.name / user.email** | 全新机器上 `commit-tree` 会因为缺身份直接失败。所以打点时显式给一次性身份 `mya-checkpoint`，不写进用户的 git config |
| **失败必须安静** | 没装 git、不是仓库、目录太大超时——一律返回 `{ok:false}`，绝不让一次正常的写入失败。**也绝不替你 `git init`**：要不要建仓库是你对自己项目的决定 |

## 已知边界（如实写清）

- **回滚不会删除检查点之后新建的文件**：`git restore` 只把 ref 里存在的路径恢复成当时的样子。
  这是有意的——把「agent 新建的文件」也一起删掉更危险。
- **行尾**：回滚走的是 git 自己的 `core.autocrlf` 规则，所以在 Windows 上恢复出来的文件
  行尾可能和当时不一样（这与你手动 `git checkout` 的行为一致）。
- **只在 git 仓库里生效**：不在仓库里就什么都不做（工具结果里也不会有那一行提示）。
- **默认留最近 50 个**（`checkpoint.keep`），旧的自动清理；`refs/mya/checkpoints/*` 不会出现在
  你的分支列表里，但它们确实存在于 `.git` 里，占的空间等于「被改动文件」的那几份快照。

## 配置

```json
{
  "checkpoint": {
    "enabled": true,
    "keep": 50
  }
}
```

`enabled: false` 就彻底不打点（工具调用不再有任何 git 开销）。

## 测试

`node test/selftest.js` 里有一组（`2.5 git 检查点`）专门盯这四条约束：

- 打点前后 `HEAD` / `status` / `--cached` / `reflog` 全部逐一比对**必须完全相同**
- 未跟踪文件必须进检查点；被 `.gitignore` 忽略的必须不进
- 回滚能恢复内容、且**不移 HEAD**；回滚后新建的文件仍在（边界按设计走）
- 不是仓库：`ok:false`、不抛异常、**不会生成 `.git` 目录**、列表为空
- 清理只留最近 N 个；`show` 能列出改动的文件
