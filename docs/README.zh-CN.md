# GeodeDrive

[English](../README.md) · [Русский](README.ru.md) · **简体中文** · [Español](README.es.md)

[![CI](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml/badge.svg)](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-%3E%3D1.4.0-7c3aed.svg)](https://obsidian.md)
[![Mobile](https://img.shields.io/badge/mobile-iOS%20%7C%20Android-success.svg)](#)
[![Encryption](https://img.shields.io/badge/encryption-AES--256--GCM-informational.svg)](#加密)

插件把 Obsidian 仓库备份到**你自己的** Google Drive，还可以对选定的文件和文件夹加密。

桌面端和手机端都能用：不使用 Node API，不使用 `fetch`，运行时零依赖。

![panel](assets/panel.png)

> [!NOTE]
> **本译文由大语言模型生成，未经母语者校对。** 唯一权威版本是[英文 README](../README.md)：如有出入，
> 以英文为准。若发现措辞生硬、错误或术语不准确，请修改 `docs/README.zh-CN.md` 并发起 PR，或
> [提交 issue](https://github.com/lif0/geode-drive-backup/issues)。哪怕只修一行也很有价值。也欢迎新的
> 语言：把英文文件复制为 `docs/README.<代码>.md`，保持相同的章节顺序，并把它加进上面的语言行。

> 本文中的命令名、设置项和按钮名保留英文原文，因为 Obsidian 界面中显示的就是英文。

---

## 安装

### 从发布版安装

1. 从[最新发布页](https://github.com/lif0/geode-drive-backup/releases)下载 `main.js` 和
   `manifest.json`。
2. 放进 `<你的仓库>/.obsidian/plugins/geode-drive-backup/`。
3. 重启 Obsidian，然后在 _Settings → Community plugins_ 中启用 **GeodeDrive**。

### 从源码构建

```bash
git clone https://github.com/lif0/geode-drive-backup.git
cd geode-drive-backup
npm install
npm run build          # 类型检查 + lint + 测试 + 打包
```

把 `main.js` 和 `manifest.json` 复制到仓库里的插件目录，或者在那里创建指向代码库的软链接并运行
`npm run dev`——构建就会自动更新。

---

## 配置：你自己的 Google OAuth 客户端

GeodeDrive 绝不让你的笔记经过别人的服务器，所以 Google 凭据要你自己创建。这是一次性的配置，大约十分钟。

1. 打开 [Google Cloud Console](https://console.cloud.google.com/) 并创建一个项目。
2. **APIs & Services → Library** → 启用 **Google Drive API**。
3. **APIs & Services → OAuth consent screen**。在当前版本的控制台中，这会打开 **Google Auth
   Platform**。点击 **Get started**，填写应用名称、用作 support email 的你的邮箱、
   **Audience: External**，以及再次填入你的邮箱作为联系方式。
4. 打开 **Audience** 标签页并点击 **Publish app**，让状态变为 _In production_。如果想跳过这一步，
   请先读下面的提示框：对备份工具来说它是必须的。
5. 打开 **Clients** 标签页 → **Create client** → 应用类型选择
   **TVs and Limited Input devices** → 起个名字 → **Create**。
6. 复制 **Client ID** 和 **Client secret**。
7. 在 Obsidian 中：_Settings → Geode_ → 粘贴这两项，然后点击 **Connect**。
8. 弹窗会显示一个短代码和一个网址。在任何方便打字的设备上打开该网址，输入代码并授权——弹窗会自动
   关闭。

> [!IMPORTANT]
> **不要把应用留在 _Testing_ 状态。** 对处于该状态的任何 External 应用，Google 签发的 refresh
> token 只能存活 **7 天**。此后 GeodeDrive 每周都会以 “Google revoked this connection” 失败，永远
> 如此。点击 **Publish app** 可以一劳永逸地解决。
>
> 发布是免费的。你仍然是唯一的用户，而 `drive.file` 属于 **non-sensitive** 权限：既不需要提交
> 审核，也不需要安全评估。同意页面可能提示应用未经验证——对于只有你自己使用的应用这很正常：
> 展开 **Advanced** 继续即可。
>
> 如果你有意保持 _Testing_ 状态，请先在 **Audience → Test users** 中添加自己的账号。该栏目只在
> 状态为 _Testing_ 时存在——发布之后你就找不到它了。

为什么客户端类型的名字这么奇怪、为什么客户端要你自己创建、以及为什么发布应用是安全的，写在
[docs/auth-design.md](auth-design.md)（英文）。

GeodeDrive 只申请一个权限范围——`https://www.googleapis.com/auth/drive.file`。它只开放插件自己创建
的文件；你 Drive 上的其他任何内容它都读不了。

即使已发布，令牌在下列情况下仍会失效：你在
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) 撤销了授权，或者半年
里没有一次推送也没有一次拉取。

> **登录不了，Google 拒绝 device flow？**
> 说明你的客户端类型不对。要么重新创建为 _TVs and Limited Input devices_，要么在设置中把
> **Sign-in method** 切换为 _Redirect with PKCE_。该方式会打开常规的 Google 授权页，然后跳转到
> `127.0.0.1`——这个页面自然加载不出来——并请你把地址栏内容粘贴回 Obsidian。样子不好看，但它不
> 需要本地 Web 服务器，所以在手机上同样可用。

只有 refresh token 会写入磁盘。access token 只存在于内存中——插件在需要时重新获取。

---

## 使用

命令面板（`Ctrl/Cmd+P`）里有七个命令。此外还有侧边栏图标和状态栏项——两者都会打开面板——设置页
顶部还有 **Push now** / **Pull now** 按钮。

| 命令                         | 作用                                           |
| ---------------------------- | ---------------------------------------------- |
| **Push changes to Drive**    | 上传新增和变更的文件，其余跳过。               |
| **Pull vault from Drive**    | 下载整个备份。绝不覆盖，绝不删除。             |
| **Unlock encryption**        | 校验口令并把密钥缓存到本次会话。               |
| **Connect Google account**   | 运行登录流程。                                 |
| **Show backup status**       | 连接状态、文件夹、已跟踪文件数、加密状态。     |
| **Show progress panel**      | 打开面板。侧边栏图标和状态栏也能做到。         |
| **Cancel current operation** | 在当前文件完成后停止，不会留下写了一半的内容。 |

### 面板

侧边栏图标会在右侧打开面板——就是[开头图片里的那个](#geodedrive)。备份从这里启动，进度也在这里
看。面板本身不会发送任何东西，除非你按下按钮。而在启动之前，不妨先看看到底会发送什么。

**Check** 是一次试运行：它统计一次推送会发送什么，但什么都不发送，顺便向 Drive 询问还剩多少
空间。这一步不需要口令。试运行并不是零成本的：要弄清什么变了，就得像 push 一样把仓库走一遍。所以
它由按钮触发，而不是每次打开面板就自动运行。

最后一行说的是 Drive 的剩余空间。如果空间用完了，push 会以 `storageQuotaExceeded` 失败，重试也
没有意义。面板会提前警告你，赶在发送之前。

### 文件浏览器中的圆点

Obsidian 侧边栏里的每个文件和文件夹旁都会出现一个圆点，显示该文件的状态。

| 圆点     | 含义                               |
| -------- | ---------------------------------- |
| **绿色** | 已在 Drive 上，且此后本地没有改动  |
| **橙色** | 从未推送过，或推送之后又改动了     |
| **灰色** | 已被排除，且该行显示为半透明       |

文件夹会取其内容中最「扎眼」的颜色。绿色的文件夹意味着其中所有文件都已在 Drive 上；一条未推送的
笔记就会把整个分支染成橙色。

颜色根据文件的大小和修改时间计算，而不是哈希——这与 push 判断文件无需重读所用的捷径相同。如果
某个文件的哈希被标记为不可信（下文时间戳一节会讲），圆点会是橙色。这是诚实的：下一次推送确实会
重新读取该文件。

> Obsidian 没有提供装饰文件树的 API，所以圆点是直接画在浏览器自身的标记之上的——依据每一行都
> 带有的 `data-path` 属性。插件不会读取任何隐私内容，但这依赖的是内部标记而非官方契约。如果圆点
> 哪天消失了，首先要怀疑的就是它。可以用 **Mark files in the file explorer** 设置关闭。

### 如何跟踪一次运行

推送或拉取进行时，可以在三个地方跟踪进度。它们都不会被误关。

- **状态栏**，右下角——显示 `Geode 142/486 · 38%`。点击它会打开面板。
- **面板。** 里面会出现两条进度条：一条对应整个运行，另一条对应当前文件。旁边能看到字节数、
  文件名和 Cancel 按钮。在推送进行到一半时打开面板，看到的是推送本身，而不是空白页面。
- **最终通知**，带有摘要。

总进度条按字节计数，而不是按文件，所以从第一秒起就显示真实的进度：插件事先知道哪些文件会被
发送、它们有多大。一百条笔记加一个视频不是一百零一个等长的步骤。

当前文件的进度条只在大文件上移动——就是分块上传的那些。它们是超过 5 MB 的文件，走 resumable
通道，按 1 MB 分块。更小的文件在一个请求里完成，而 Obsidian 的 `requestUrl` 在请求结束前不会汇报
任何信息——所以小文件的进度条会一次性填满。实际就是这样发生的，也就这样显示。

得益于分块，**Cancel 在大文件内部也能生效**，而不只是在文件之间。一个 400 MB 的视频会在一兆字节
内停下，而不是拖到最后。

> 手机端的 Obsidian 不给插件提供状态栏。在那里可以通过面板和侧边栏图标跟踪进度。

### 典型的首次运行

```
Connect Google account   →   Push changes to Drive
```

首次推送会创建 Drive 文件夹（默认名为 `Geode`）并上传全部内容。之后只上传发生变化的部分。

### 在新设备上恢复

```
安装 Geode  →  粘贴相同的 client ID 和 secret  →  Connect  →  Pull vault from Drive
```

Pull 会下载所有文件，并从编码后的文件名重建目录树。如果仓库中同一路径已经存在文件，而插件无法
证明两者完全相同，Drive 上的副本会以 `note (from drive).md` 的名字写在旁边。再次冲突时依次为
`(from drive 2)`、`(from drive 3)`，以此类推。**Pull 绝不删除，也绝不覆盖。**

路径是否重合按不区分大小写判断——即使在 Linux 上。对 Drive 来说 `Note.md` 和 `note.md` 是两个
文件，而对 APFS、NTFS 和 Android SD 卡上的 exFAT 来说是同一个，写入第二个就会悄悄毁掉第一个。在
真正区分大小写的文件系统上，你只是多得到一份 `(from drive)` 副本；往另一个方向猜错的代价则是丢掉
一条笔记。

### 如何中止长时间运行

推送和拉取随时可以中止：点击进度通知上的 **Cancel** 按钮，或执行 **Cancel current operation**
命令。插件会先完成当前文件再停止，因此不会在 Drive 上留下传了一半的文件，也不会在仓库里留下被
截断的文件。

已经传输完成的内容都会保留。索引不只在结束时写入，而是每 25 个文件写一次，所以被中止的运行会从
中断处继续——无论是你自己取消的，还是手机没电了。

### 如何看结果摘要

每次运行结束都会有一条通知。

```
Push finished: 12 uploaded, 3 updated, 486 unchanged.

2 skipped — changed on another device:
  Journal/2026-07-30.md
  Projects/roadmap.md
```

**冲突**意味着自本设备上次写入之后，Drive 上的副本被改动过。插件不去猜哪个版本才是对的：它跳过
该文件并告诉你。接下来可以执行 pull，把两份副本并排拿到手，或者手动处理。

摘要里有时还会出现一条**警告**——比如同一路径在 Drive 上对应了两个文件，或者文件夹里出现了插件
没放进去的文件。这些不会计入统计数字，但意味着备份的实际形态和你想的不完全一样。

---

## 哪些内容会进入备份

仓库里很少只有笔记。通常还会混进构建产物、二进制文件、整个程序目录和大体积视频。为文字而建的
备份用不着这些。

有两个开关。默认都是关闭的，都支持 `.gitignore` 语法。

| 设置项                               | 作用                                       |
| ------------------------------------ | ------------------------------------------ |
| **Respect the vault's `.gitignore`** | 读取仓库根目录的 `.gitignore` 并应用它     |
| **Never upload these paths**         | 你自己的规则，在该文件之后应用             |

设置里的规则排在第二位生效，所以其中的 `!` 可以把仓库 `.gitignore` 排除掉的内容找回来。仓库首先
是代码库，其次才是备份对象，这两个角色需要的文件并不总是相同。

```gitignore
bin/                    # 任意深度的文件夹，包括 Projects/app/bin
[Oo]bj/                 # 字符类可用
/Drafts                 # 开头的斜杠把它锚定到仓库根目录
*.mp4                   # 任意深度、任意文件夹
!Notes/demo.mp4         # ……但这个文件除外
**/.idea/**/*.iml       # ** 可以跨越文件夹
```

支持 `#` 注释、`!` 取反（以最后匹配的规则为准）、`/` 锚定、结尾斜杠表示文件夹、`*`、`?`、`**`，
以及字符类 `[abc]` / `[!a-z]`。仓库内部嵌套的 `.gitignore` 不会被读取——只读根目录那一个。

开启之前值得知道的三件事。

- **不带斜杠的规则在任意深度都会命中。** `test/` 既会排除根目录的 `test/`，也会排除
  `Notes/test/`。git 就是这么设计的——而人们通常也正是这样不小心丢掉装着真笔记的文件夹。点一下
  设置里的 **Preview exclusions**：插件会把规则套用到你的仓库上，展示哪些内容会被排除在外。这个
  过程不会上传任何东西。
- **排除不等于删除。** 文件不再进入备份后，它在 Drive 上的副本哪儿也不会去：插件既不会更新它，
  也不会删除它——即使开启了删除同步。一个在你排除文件的当天就把它忘掉的备份，算不上备份。
- **排除只作用于 push，不作用于 pull。** 它们决定的是什么会离开这台设备。已经在备份里的东西都能
  取回来——备份存在的意义就在这里。

被排除的文件根本不会被打开。被排除的那些 GB 不再消耗每次推送的时间：不必为了最终跳过它们而去
读取和计算哈希。摘要里会写明有多少文件被排除在外。

面板里的 **Show what is excluded** 按钮以树的形式展示完整清单。文件夹初始是折叠的，每个都标注了
内部文件数和总大小。几千条被排除的路径浓缩成十来行真正读得完的内容——混在构建产物中间、被误加
进清单的 `Journal` 文件夹在这里很难被漏看。最重的文件夹排在最上面：排除的收益通常几乎都集中在
其中两三个。

以点开头的文件和文件夹，Obsidian 根本不会展示给插件。所以 `.obsidian/`、`.git/`、`.idea/` 之类
从来就不在备份里——针对它们的规则也不会改变什么。

---

## 加密

默认关闭。开启后，路径匹配到你所配置前缀的文件会在**离开本机之前**被加密。

- **算法：** AES-256-GCM，每个文件每次推送都使用全新的随机 12 字节 nonce。
- **密钥：** PBKDF2-SHA256，600,000 次迭代，32 字节密钥，每个仓库一个 16 字节随机盐。
- **容器：** `MAGIC "OBEV" | VERSION 0x01 | SALT (16) | NONCE (12) | ciphertext+tag`。

密钥在解锁时只推导一次并保存在内存中：如果每个文件都重新推导，Obsidian 在任何实际规模的仓库上都
会卡死。插件卸载时密钥会被清除。口令本身不会写到任何地方。

### 选择加密哪些内容

在设置中每行列出一个路径前缀。规则刻意做得简单：过于聪明的规则迟早会让你以为已加密的文件以明文
上传。

| 前缀       | 匹配                                        | 不匹配          |
| ---------- | ------------------------------------------- | --------------- |
| `Journal`  | `Journal`、`Journal/2026.md`、`Journal/a/b` | `Journalism.md` |
| `Journal/` | 同上                                        | `Journalism.md` |
| `Journal*` | `Journal/2026.md`、`Journalism.md`          | `Diary.md`      |

匹配区分大小写。`*` 只在行尾有特殊含义。以 `#` 开头的行会被跳过。

### 口令校验文件

首次加密推送会在 Drive 文件夹中放入一个名为 `__keycheck` 的小文件——其中是仓库的盐和一段插件
已知的标记字符串。新设备会先下载它，并在**接触任何真实数据之前**校验你的口令。口令错误时一切
立即停止，磁盘上不会有任何改动。

### 需要了解的限制

- **文件名没有加密。** 路径经过 base64url 编码以便 Drive 接受——那是编码而不是加密。任何能访问
  该文件夹的人都能看到你仓库中的所有路径。
- **文件大小没有隐藏。** 容器的大小等于原始文件加 49 字节。
- **没有找回机制。** 忘记口令，加密文件就没了——对你如此，对任何人都如此。
- 文件是否加密由插件在下载时根据 `OBEV` 文件头判断。扩展名和 Drive 元数据里的 `enc` 标志都不能
  用来判断：这两者都会逐渐与实际脱节，文件头不会。

---

## 不依赖 Obsidian 的灾难恢复

`tools/decrypt.mjs` 是完全独立的：它不从 `src/` 取任何东西，既不需要 `npm install`，也不需要
构建。把这一个文件放到已下载的 Drive 文件夹旁边，只用 Node 和口令就能取回笔记。

```bash
# 单个文件输出到 stdout
node tools/decrypt.mjs 5rWL6K-VLm1k

# 单个文件写入磁盘
node tools/decrypt.mjs 5rWL6K-VLm1k -o note.md

# 从下载的 Drive 文件夹恢复整个仓库
# 解码文件名，解密已加密的文件，其余原样复制
GEODE_PASSPHRASE='…' node tools/decrypt.mjs --dir ./downloaded-Geode --out ./restored

# 验证该工具与插件的实现一致
node tools/decrypt.mjs --verify-vectors test/vectors.json
```

脚本先从 `--passphrase` 取口令。没有的话，读环境变量 `GEODE_PASSPHRASE`。连它也没有，就直接询问。

### 黄金测试向量

`test/vectors.json` 固定了四个用例：空文件、短 ASCII、含西里尔字母和 emoji 的 UTF-8，以及 1 MiB
二进制数据。每个用例都记录了口令、盐、nonce、明文和精确的预期容器内容。

两个相互独立的实现必须在全部四个用例上一致：`src/core/container.ts` 由 `npm test` 校验，
`tools/decrypt.mjs` 由 `npm run verify:vectors` 校验。CI 会同时运行两者。向量只增不改：如果格式
变了，就提升 `VERSION` 并追加新用例，而不是修改旧的。

---

## 变更检测的原理

为了判断文件是否变了，插件把它**明文**的 SHA-256 与 `data.json` 里的本地索引进行比较。

这件事比听起来更重要。加密文件每次推送都会得到新的 nonce，因此密文——连同 Drive 上的
`md5Checksum`——每次都会变，哪怕笔记本身没动。如果插件以 Drive 上的校验和为准，它就得在每次运行
时重新上传整个仓库。明文哈希是唯一保持不变的东西。

远端 md5 只用于一件事：由它可以看出文件被**另一台设备**重写过。那是冲突，这样的文件插件拒绝
覆盖。

明文哈希永远不会离开你的设备。如果插件把它随加密文件一起上传，任何能访问该文件夹的人都可以验证
自己对内容的猜测。

由此得出的几点。

- 如果一个文件的修改时间**和**大小都与索引一致，插件就直接沿用已记录的哈希，根本不打开文件。在
  改动很少的大仓库上，push 会遍历所有文件，却几乎一个都不读。最终判断仍然只由 sha256 做出：修改
  时间不能证明文件变了——它只说明文件可能变了。
- 这个捷径成立的前提是文件系统的时钟比你的编辑更精细。FAT32——Android SD 卡通常就是这种格式——
  把时间取整到两秒。落在同一个时间刻度内、又没有改变文件大小的编辑，会永远无人察觉。因此，如果
  文件的修改时间距现在不足一个刻度，它的哈希会被标记为不可信，下次会重新读取该文件。
- Pull 不走这类捷径，对所有内容都计算哈希。用到它的时候往往已经出了问题，此时判断失误的代价更
  高：如果插件误以为本地文件与备份一致，就不会把备份副本下载到旁边。
- 路径统一规范化为 Unicode NFC。macOS 把 `é` 拆成 `e` 加一个独立的重音符号，而 Windows 和 Linux
  用单个码位。不做规范化，同一条笔记会以两个不同的名字上传到 Drive 两次，并且永远和自己冲突。
- 丢失 `data.json` 并不可怕。下次推送会看到自己毫无记录的文件，在 Drive 上找到它们并报告冲突，
  而不是覆盖。Pull 会重建索引。
- 一条路径如果在仓库**和** Drive 上都不存在了，它在索引里的记录就会被删除。所以 `data.json` 不会
  无限膨胀，已跟踪文件数也保持真实。
- `.obsidian/` 永远不会进入备份：`data.json` 就放在那里，里面存着你的 Google refresh token。

### 与 Drive 的交互

- **限流是常态，不是错误。** 对成批上传，Drive 会照例回以 429 或临时的 5xx。插件会以逐渐加长的
  间隔加上随机抖动重试这类请求，遵循 `Retry-After`，最多尝试五次。因频率限制产生的 403 也会
  重试，而带 `storageQuotaExceeded` 的 403——即空间用尽的那种——不会：等下去毫无意义。等待期间
  同样会检查取消操作，所以不必硬熬完二十秒的暂停。
- **如果一切都以同一种错误失败，运行就会停止。** 连续五次网络错误或权限错误后，插件会结束运行并
  说明原因。否则它会翻完两千个文件，把同一个问题汇报两千遍。已经传输的内容都会记录在案。
- **超过 5 MB 的文件通过 resumable 会话上传，每次 1 MB。** Google 只建议 5 MB 以下的文件走
  multipart，而大附件恰恰是备份不容有失的文件。分块上传的代价是每兆字节多一次网络请求，换来的是
  文件内部的进度显示，以及不只在文件之间起作用的 Cancel。大文件下载同理，按范围分段。
- **保存下来的文件夹 id 会被验证，而不是无条件信任。** 如果 Drive 上的文件夹被移进了回收站，
  或者你连接了另一个 Google 账号，列表请求依然会成功并返回空列表——从外面看就像「Drive 弄丢了
  整个仓库」。每次运行开始时的一个请求，会把这种情况变成一次普通的按名称查找。
- **同一路径可能对应 Drive 上的两个文件。** Drive 不要求文件名唯一，所以两台设备几乎同时创建
  同一条笔记，得到的正是这种结果。插件会取较新的那个文件——在所有设备上选择一致——并在摘要中
  说明，而不是把另一份副本藏起来。

### Drive 上的存储布局

扁平结构。一个文件夹，仓库中每个文件对应一个 Drive 文件，没有嵌套。

```
Geode/
  bm90ZS5tZA                    ← base64url("note.md")
  Sm91cm5hbC8yMDI2LTA4LTAxLm1k  ← base64url("Journal/2026-08-01.md")
  __keycheck
```

路径直接放在文件名里，因为 Drive 的 `appProperties` 每个键/值对上限约为 124 字节——任何含非
ASCII 字符的路径都塞不进去。`appProperties` 里只存 `{ v, enc }`。

每次上传都把这个文件夹指定为父目录，所以插件写入的内容不可能落到别处。而 `drive.file` 权限让它
根本看不到你 Drive 的其余部分。

文件夹创建在「我的云端硬盘」根目录，插件不会提供选择其他位置的方式：在 `drive.file` 权限下它看
不到你的目录树，也就无处获取父目录的 id。想整理一下的话，**在 Drive 网页端把它拖过去一次即可**。
插件通过 file id 访问它，甚至不会察觉搬家。而如果 `data.json` 哪天丢了，后备查找会按名称搜索且
不限定父目录，无论你把它放在哪里都能找到。

---

## 设置项参考

| 设置项                          | 默认值     | 说明                                           |
| ------------------------------- | ---------- | ---------------------------------------------- |
| Client ID / secret              | 空         | 你自己的 Google OAuth 客户端                   |
| Sign-in method                  | Device     | 只有当 Google 拒绝 device flow 时才切换到 PKCE |
| Drive folder name               | `Geode`    | 推送之后再改，插件会去看另一个文件夹           |
| Respect the vault's .gitignore  | 关闭       | 读取根目录的 `.gitignore` 并跳过其排除的内容   |
| Never upload these paths        | 空         | 你自己的规则，`.gitignore` 语法，在其之后应用  |
| Mark files in the file explorer | 开启       | 每个文件和文件夹旁一个圆点：绿、橙或灰         |
| Encrypt selected paths          | 关闭       | 开启后启用下面的前缀列表                       |
| Encrypted paths                 | 空         | 每行一个前缀                                   |
| Ask for the passphrase          | 每会话一次 | 或者每次推送和拉取都询问                       |
| **Mirror deletions to Drive**   | **关闭**   | 开启后，本地删除会永久移除 Drive 上的副本      |

> **关于同步删除。** 设置关闭时，你在本地删除的文件仍然留在备份中——通常这正是做备份的意义
> 所在。开启后，推送会永久删除 Drive 上的副本，并绕过回收站。一个把你删过的东西都忘掉的备份，
> 也就没法再帮你找回它们。
>
> 这不影响排除规则。即使开启了删除同步，把路径加进 `.gitignore` 也不会删除它在 Drive 上的副本。
> 被排除的文件是插件不再触碰的文件，不是你要求抹掉的文件。

---

## 开发

```bash
npm run dev             # esbuild 监听模式
npm run typecheck       # 对 src、test 和 tools 运行 tsc
npm run lint            # eslint，启用类型感知规则
npm run test            # 针对 src/core 运行 vitest
npm run verify:vectors  # 独立解密工具对照黄金向量
npm run format
npm run build           # 全部检查，然后产出生产包
```

### 目录结构

```
src/
  main.ts        生命周期、命令、装配——不含业务逻辑
  types.ts       品牌类型、Result、AppError
  settings.ts    设置结构、默认值、迁移
  core/          纯逻辑：container、kdf、path-codec、selector、ignore、
                 diff、backup-state、path-tree、bytes
  drive/         auth-provider、device-flow、pkce-flow、client、dto
  ops/           push、pull、estimate、folder、index-store
  ui/            settings-tab、模态框、progress hub、进度面板
test/            只针对 src/core 的 vitest——无 mock，无 Obsidian 桩
tools/           独立解密工具、向量生成器、版本号同步
```

有两条规则由构建流程自行检查，而不是靠口头约定。

- **`src/core/` 中的任何文件都不导入 `obsidian`。** 所有 I/O 都从外部注入，因此加密逻辑和比较
  逻辑可以在纯 Node 环境下无 mock 地测试。
- **`src/` 中的任何文件都不触碰 Node API。** `tsconfig.json` 设置了 `types: []`，因此 `Buffer`、
  `process` 和 `require` 根本无法通过编译；ESLint 还会按名字禁止它们以及 `fetch`。所有 HTTP 都走
  Obsidian 的 `requestUrl`——那是渲染进程中唯一能绕过 CORS 的途径。

验证起来很简单：在 `src/` 下的任意文件里写 `Buffer.from('x')`，`npm run typecheck` 和
`npm run lint` 都会拒绝它。

---

## 许可证

[Apache-2.0](../LICENSE)
