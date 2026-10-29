# 发布到 DSH 插件社区（实操清单）

> 结论先说：DSH 的「插件社区」= **[awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 这个收录仓库**。
> dshmarket（插件市场）、awesome-dsh-plugin.com、以及 dsh 0.2.1+ 的 **Plugins → Discover → Index sources**
> 都从它的 `data/plugins/*.yml` 生成的数据读，所以**只需要往那个仓库提一个 YAML 文件**。
> npm 发布是**可选**的（能让市场显示下载量、并让安装跳过源码构建），而 dshmarket 明确写着
> 「Installs are restricted to sources listed in the curated awesome-dsh-plugin registry — anything else is rejected」，
> 所以**收录是进入市场的唯一通道**，没有第二个注册表可发。

## 已经替你做好的准备

| 项 | 状态 |
| --- | --- |
| `package.json` 发布就绪 | 已去掉 `private`，补了 `license`/`author`/`repository`/`homepage`/`bugs`/`keywords`/`engines`/`publishConfig.access=public` |
| `LICENSE` | 已加（MIT，Copyright (c) 2026 ypx01） |
| npm 包内容 | `npm pack --dry-run` 通过：9 个文件 / 18.2 kB（index.js、client.js、cordis.patch.yml、locale×2、icon.svg、README、LICENSE、package.json） |
| npm 包名 | `dsh-auto-shutdown` **未被占用**（registry 404） |
| `npm publish --dry-run` | 通过（只提示未登录） |
| PR 条目文件 | 已备好：`publish/awesome-entry.yml` → 复制成目标仓库的 `data/plugins/ypx01__dsh-auto-shutdown.yml`（`icon:` 已指向 `assets/icon-180.png`） |
| 市场图标 | `assets/icon-180.png`：180×180 PNG、透明圆角，由 `icon.svg` 用无头 Chrome 栅格化（`--default-background-color=00000000` 保留透明） |
| 仓库卫生 | `.gitignore`（node_modules / 日志 / .env / 编辑器缓存 / 构建产物） |
| 文档 | `README.md`（中文）+ `README.en.md`（英文，含安装/配置/自检/踩坑/边界），两页互链 |

⚠️ 两件事只有你能做：**GitHub 建仓推送**（`git config user.name` 是 `ypx01`）和 **npm 登录**（这台机器
`npm whoami` 目前是 ENEEDAUTH）。

## 第 1 步：建公开 GitHub 仓库（年龄门槛从这里开始算）

收录硬性要求里有 **「仓库创建满 1 天」**（CI 自动查，PR 前几分钟建的仓必被打回）。
所以这一步要最先做，做完等一天再提 PR。

本目录**已经**是 git 仓库（分支 `main`，2 个提交，`origin` 已指向 `https://github.com/ypx01/dsh-auto-shutdown.git`，
提交邮箱已设为 GitHub 的 noreply 地址 `349763228+ypx01@users.noreply.github.com`，不暴露真实邮箱），
所以**只需**在网页建好空仓库再 push 一次：

1. 打开 <https://github.com/new> → Repository name 填 `dsh-auto-shutdown` → **Public** →
   **不要**勾 Add a README / .gitignore / license（仓库必须是空的）→ Create repository
2. 在 `D:\deepseek-workspace\plugins\dsh-auto-shutdown` 里执行（首次会弹浏览器登录，登录一次后凭据会记住）：

```powershell
git push -u origin main
```

建完立刻在仓库页 **About ⚙ → Topics** 加上 **`dsh-plugin`**（收录要求，也是榜单 topic 的来源）。

> 如果不想用 `ypx01` 这个名字：`package.json` 里的 `repository`/`homepage`/`bugs` 三个 URL 要同步改，
> 条目文件里的 `url`/`name` 也要改——npm 包要求 `repository` 指回被收录的那个仓库，否则两者不会关联。

## 第 2 步（可选但推荐）：发 npm

好处：市场卡片显示下载量；用户 `dsh plugin add` 时走预构建包，跳过 `allowBuilds` 构建授权（我们本来也没有构建脚本，但体验更顺）。

```powershell
npm.cmd login          # 注意这台机器的 npm.ps1 被执行策略拦住了，用 npm.cmd
npm.cmd publish        # publishConfig 已设 access=public，无需再加 --access
```

## 第 3 步：提 PR（一个文件就是全部投稿）

**不用装任何工具的做法（推荐）**：GitHub 网页上直接加文件。

1. 打开 <https://github.com/awesome-dsh-plugin/awesome-dsh-plugin> → 右上 **Fork** → Create fork
2. 在自己 fork 的仓库页 → **Add file → Create new file**
3. 文件名填 `data/plugins/ypx01__dsh-auto-shutdown.yml`（输入 `/` 会自动建目录）
4. 把本仓库 `publish/ypx01__dsh-auto-shutdown.yml` 的内容整段粘进编辑框
5. **Commit changes** → 选 *Create a new branch for this commit and start a pull request*（分支名 `add-dsh-auto-shutdown`）→ **Propose changes**
6. 标题填 `Add ypx01/dsh-auto-shutdown`，正文一句话（例如 "Per-session auto-shutdown switch; tested on Windows 11 with dsh 0.2.x."）→ **Create pull request**

装了 `gh` 的话等价于：

```powershell
winget install --id GitHub.cli -e     # 只需一次
gh auth login
gh repo fork awesome-dsh-plugin/awesome-dsh-plugin --clone
cd awesome-dsh-plugin
git checkout -b add-dsh-auto-shutdown
New-Item -ItemType Directory -Force data\plugins | Out-Null
Copy-Item D:\deepseek-workspace\plugins\dsh-auto-shutdown\publish\ypx01__dsh-auto-shutdown.yml data\plugins\ypx01__dsh-auto-shutdown.yml
git add data/plugins/ypx01__dsh-auto-shutdown.yml
git commit -m "add ypx01/dsh-auto-shutdown"
git push -u origin add-dsh-auto-shutdown
gh pr create --title "Add ypx01/dsh-auto-shutdown" --body "Per-session auto-shutdown switch. Tested on Windows 11 with dsh 0.2.x."
```

规则要点（都来自 `contributing.md`，照做就不会被打回）：

- **只提交 `data/plugins/<owner>__<repo>.yml`**，README 是脚本生成的，**不要手改**。
- 一个 PR **最多 3 条**。
- `category` 用枚举值：`agi ui usage theme model identity session memory tools wsl browser vision voice docs skill workflow git notify dev security remote market fun`。本插件选 **`workflow`**（自动化，任务结束触发动作）。选偏了维护者会直接改，不会打回。
- `description.en` 必填、**以句号结尾、必须属实**（维护者会对着代码核对，夸大是主要打回原因）。含 `: ` 要加引号——条目文件里已经加好了。
- 收录要求：`dsh.bundle` manifest（✅ 有，`./cordis.patch.yml`）、真实可跑代码（✅）、仓库满 1 天（⏳ 第 1 步之后）、活跃维护（后续发版即可）、`dsh-plugin` topic（✅ 第 1 步）。
- CI 依次查：条目数 ≤3 → 从你仓库的 `package.json` 读 `dsh.bundle` → 仓库年龄 → awesome-lint 与站点构建。
- 维护者要改东西时会打 `held: author` 标签：把修复推到**同一分支**，留**一条**评论说明改了什么即可，不要反复推空提交。
- 可选字段：`tarball:`（不发 npm 时指 GitHub Release 的 `.tgz`）、`icon:`（**必须是 GitHub 托管的位图**，SVG 会被拒）。

## 合并之后

- README 与站点自动重建，通常在一天内出现在：
  - 榜单 https://awesome-dsh-plugin.com
  - **dshmarket** 市场（Settings → Plugins 那个界面里的浏览页）
  - dsh 0.2.1+ 的 Discover（索引源 `https://cdn.jsdelivr.net/npm/dsh-plugin-catalog/index.json`）
- 用户安装命令：`dsh plugin add dsh-auto-shutdown`（桌面版就是在市场里点一下 Install）。

## 可选加分项

1. ~~**市场卡片图标**~~ **已就绪**：`assets/icon-180.png`（180×180、透明圆角、由 `icon.svg` 经无头 Chrome 栅格化），
   条目文件里的 `icon:` 已启用——只要仓库推上去、文件在 `main` 分支，市场卡片就有图标。
   想换图：改 `assets/icon-180.png` 即可（保持位图，别再换回 SVG，收录会拒）。
2. **商店页截图**：在自己仓库 `package.json` 旁边放 `screenshots.json`（1–8 张相对路径），市场详情页会像 App Store 一样展示。
   不写也能用，市场会从 README 自动抽图。
3. ~~**双语 README**~~ **已就绪**：`README.md`（中文）+ `README.en.md`（英文）互相链接。

## 之后怎么发新版

1. 改代码 → 改 `version` → `npm.cmd publish`
2. 描述没变就**不用**再动条目文件；要改描述时，**只改自己那一条** `data/plugins/ypx01__dsh-auto-shutdown.yml` 再提 PR。
3. 市场侧「更新」按钮会拿 npm 版本与本地比较，用户点一下就升级。
