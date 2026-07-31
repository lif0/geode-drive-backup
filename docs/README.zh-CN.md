# Geode

[English](../README.md) · [Русский](README.ru.md) · **简体中文** · [Español](README.es.md)

[![CI](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml/badge.svg)](https://github.com/lif0/geode-drive-backup/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](../LICENSE)
[![Obsidian](https://img.shields.io/badge/Obsidian-%3E%3D1.4.0-7c3aed.svg)](https://obsidian.md)
[![Mobile](https://img.shields.io/badge/mobile-iOS%20%7C%20Android-success.svg)](#)
[![Encryption](https://img.shields.io/badge/encryption-AES--256--GCM-informational.svg)](#加密)

备份，而非同步。把你的 Obsidian 仓库推送到**你自己的** Google Drive，在新设备上取回，并可选择在文件
离开本机之前加密指定的文件夹。

桌面端和手机端都能用——不使用 Node API，不使用 `fetch`，运行时零依赖。

> [!NOTE]
> **本译文由大语言模型生成，未经母语者校对。** 唯一权威版本是[英文 README](../README.md)；如有出入，
> 以英文为准。若发现措辞生硬、错误或术语不准确，非常欢迎提交修改：编辑 `docs/README.zh-CN.md` 并发起
> PR，或[提交 issue](https://github.com/lif0/geode-drive-backup/issues)。哪怕只修一行也很有价值。

> 本文中的命令名、设置项和按钮名保留英文原文，因为 Obsidian 界面中显示的就是英文。

---

## 它做什么，以及刻意不做什么

| 会做                             | 不会做                           |
| -------------------------------- | -------------------------------- |
| 上传自上次推送以来发生变化的文件 | 三方合并                         |
| 在全新设备上重建整个仓库         | 实时同步或后台同步               |
| 在客户端加密选定路径             | 永远不会删除任何本地文件         |
| 拒绝覆盖其他设备的修改           | 不传播删除操作（除非你主动开启） |
| 报告冲突然后继续                 | 不保留文件历史或版本             |

如果你需要的是同步引擎，那这个工具不合适。Geode 适合在对仓库做有风险的改动之前运行，以及在新电脑上
运行。

---

## 安装

### 从发布版安装

1. 从[最新发布页](https://github.com/lif0/geode-drive-backup/releases)下载 `main.js` 和
   `manifest.json`。
2. 放进 `<你的仓库>/.obsidian/plugins/geode-drive-backup/`。
3. 重启 Obsidian，然后在 _Settings → Community plugins_ 中启用 **Geode**。

### 从源码构建

```bash
git clone https://github.com/lif0/geode-drive-backup.git
cd geode-drive-backup
npm install
npm run build          # 类型检查 + lint + 测试 + 打包
```

把 `main.js` 和 `manifest.json` 复制到仓库的插件目录，或者把代码库软链接过去并运行 `npm run dev`
进行监听构建。

---

## 配置：你自己的 Google OAuth 客户端

Geode 绝不会让你的笔记经过任何第三方，所以 Google 凭据由你自己提供。这是一次性的工作，大约十分钟。

1. 打开 [Google Cloud Console](https://console.cloud.google.com/) 并创建一个项目。
2. **APIs & Services → Library** → 启用 **Google Drive API**。
3. **APIs & Services → OAuth consent screen**。在当前版本的控制台中，这会打开 **Google Auth
   Platform**。点击 **Get started**，填写应用名称、用作 support email 的你的邮箱、
   **Audience: External**，以及再次填入你的邮箱作为联系方式。
4. 打开 **Audience** 标签页并点击 **Publish app**，让状态变为 _In production_。
   跳过这一步之前请先读下面的提示框——对备份工具来说它不是可选项。
5. 打开 **Clients** 标签页 → **Create client** → 应用类型选择
   **TVs and Limited Input devices** → 起个名字 → **Create**。
6. 复制 **Client ID** 和 **Client secret**。
7. 在 Obsidian 中：_Settings → Geode_ → 粘贴这两项，然后点击 **Connect**。
8. 弹窗会显示一个短代码和一个网址。在任何方便打字的设备上打开该网址，输入代码并授权。弹窗会自动
   关闭。

> [!IMPORTANT]
> **不要把应用留在 _Testing_ 状态。** 对于发布状态为 _Testing_ 的 External 应用，Google 签发的
> refresh token 会在 **7 天**后失效。此后 Geode 每周都会以 “Google revoked this connection” 失败，
> 永远如此。点击 **Publish app** 可以一劳永逸地解决。
>
> 在这里发布不需要任何代价。你仍然是唯一的用户，而 `drive.file` 属于 **non-sensitive** 权限——既不
> 需要提交审核，也不需要安全评估。如果同意页面提示应用未经验证，对于只有你自己使用的应用这很正常：
> 展开 **Advanced** 继续即可。
>
> 如果你确实想保持 _Testing_ 状态，请先在 **Audience → Test users** 中添加自己的账号。该栏目只在
> 状态为 _Testing_ 时存在——这也是发布之后你找不到它的原因。

Geode 只申请一个权限范围：`https://www.googleapis.com/auth/drive.file`。它只能访问本插件自己创建
的文件——无法读取你 Drive 中的任何其他内容。范围更大的 `drive` 权限永远不会被申请：那是受限权限，
需要付费的安全评估，而一个备份工具不该碰它。

即使已发布，令牌在下列情况下仍会失效：你在
[myaccount.google.com/permissions](https://myaccount.google.com/permissions) 撤销了授权，或者连续
六个月没有执行过任何一次推送或拉取。

> **登录失败，Google 拒绝 device flow？**
> 说明你的客户端类型不对。要么重新创建为 _TVs and Limited Input devices_，要么在设置中把
> **Sign-in method** 切换为 _Redirect with PKCE_。该方式会打开常规的 Google 授权页，然后跳转到一个
> 加载不出来的 `127.0.0.1` 地址，并请你把地址栏内容粘贴回 Obsidian。样子不好看，但它不需要本地
> Web 服务器，所以在手机上同样可用。

只有 refresh token 会写入磁盘。access token 只存在于内存中，需要时重新获取。

---

## 使用

五个命令，全部通过命令面板（`Ctrl/Cmd+P`）调用：

| 命令                       | 作用                                       |
| -------------------------- | ------------------------------------------ |
| **Push changes to Drive**  | 上传新增和变更的文件，其余跳过。           |
| **Pull vault from Drive**  | 下载整个备份。绝不覆盖，绝不删除。         |
| **Unlock encryption**      | 校验口令并把密钥缓存到本次会话。           |
| **Connect Google account** | 运行登录流程。                             |
| **Show backup status**     | 连接状态、文件夹、已跟踪文件数、加密状态。 |

### 典型的首次运行

```
Connect Google account   →   Push changes to Drive
```

首次推送会创建 Drive 文件夹（默认名为 `Geode`）并上传全部内容。之后的推送只上传发生变化的部分。

### 在新设备上恢复

```
安装 Geode  →  粘贴相同的 client ID 和 secret  →  Connect  →  Pull vault from Drive
```

Pull 会下载所有文件，并从编码后的文件名重建目录树。如果仓库中已经存在同路径的文件，而 Geode 无法
证明两者完全相同，那么传入的副本会写成 `note (from drive).md`——重复冲突时依次为 `(from drive 2)`、
`(from drive 3)`，以此类推。**Pull 绝不删除，也绝不覆盖。**

### 如何看结果摘要

每次运行结束都会有一条摘要通知：

```
Push finished: 12 uploaded, 3 updated, 486 unchanged.

2 skipped — changed on another device:
  Journal/2026-07-30.md
  Projects/roadmap.md
```

**冲突**意味着自本设备上次写入之后，Drive 上的副本发生了变化。Geode 不会替你猜哪一边该赢，因此它
跳过该文件并告诉你。解决办法：执行 pull（两份副本会并排保留），或者手动决定。

---

## 加密

默认关闭。开启后，路径匹配到你所配置前缀的文件会在**离开本机之前**被加密。

- **算法：** AES-256-GCM，每个文件每次推送都使用全新的随机 12 字节 nonce。
- **密钥：** PBKDF2-SHA256，600,000 次迭代，32 字节密钥，每个仓库一个 16 字节随机盐。
- **容器：** `MAGIC "OBEV" | VERSION 0x01 | SALT (16) | NONCE (12) | ciphertext+tag`。

密钥在每次解锁时只推导一次并缓存在内存中——逐文件推导会让 Obsidian 在任何实际规模的仓库上卡死。
插件卸载时缓存会被清除。口令本身不会写到任何地方。

### 选择加密哪些内容

在设置中每行一个路径前缀。这条规则刻意做得很笨，因为"聪明"的规则意味着你以为已加密的文件明文
上传了：

| 前缀       | 匹配                                        | 不匹配          |
| ---------- | ------------------------------------------- | --------------- |
| `Journal`  | `Journal`、`Journal/2026.md`、`Journal/a/b` | `Journalism.md` |
| `Journal/` | 同上                                        | `Journalism.md` |
| `Journal*` | `Journal/2026.md`、`Journalism.md`          | `Diary.md`      |

匹配区分大小写，`*` 只在末尾有特殊含义，以 `#` 开头的行会被忽略。

### 口令校验文件

首次加密推送会在 Drive 文件夹中写入一个名为 `__keycheck` 的小文件，其中包含仓库的盐和一段已知的
标记字符串。新设备会先下载它，并在**接触任何真实数据之前**校验你的口令——口令错误时会立即中止，
磁盘上不会有任何改动。

### 需要了解的限制

- **文件名没有加密。** 路径经过 base64url 编码以便 Drive 接受，那是编码而不是加密。任何能访问该
  文件夹的人都能列出你仓库中的所有路径。
- **文件大小没有隐藏。** 容器大小等于明文长度加 49 字节。
- **没有找回机制。** 忘记口令，加密文件就没了——对你如此，对任何人都如此。
- 文件是否加密由下载时的 `OBEV` 文件头决定，而不是扩展名，也不是 Drive 元数据里的 `enc` 标志。
  后两者都会逐渐失真，文件头不会。

---

## 不依赖 Obsidian 的灾难恢复

`tools/decrypt.mjs` 是独立的。它不从 `src/` 导入任何东西，不需要 `npm install`，也不需要构建。
把这一个文件复制到已下载的 Drive 文件夹旁边，只用 Node 和你的口令就能取回笔记。

```bash
# 单个文件输出到 stdout
node tools/decrypt.mjs 5rWL6K-VLm1k

# 单个文件写入磁盘
node tools/decrypt.mjs 5rWL6K-VLm1k -o note.md

# 从下载的 Drive 文件夹重建整个仓库：
# 解码文件名，解密已加密的文件，其余原样复制
GEODE_PASSPHRASE='…' node tools/decrypt.mjs --dir ./downloaded-Geode --out ./restored

# 验证该工具与插件的实现一致
node tools/decrypt.mjs --verify-vectors test/vectors.json
```

口令依次取自 `--passphrase`、环境变量 `GEODE_PASSPHRASE`，最后才是交互式输入。

### 黄金测试向量

`test/vectors.json` 包含四个冻结的用例——空文件、短 ASCII、含西里尔字母和 emoji 的 UTF-8，以及
1 MiB 二进制数据。每个用例都记录了口令、盐、nonce、明文和精确的预期容器内容。

两个相互独立的实现必须在全部用例上一致：`src/core/container.ts`（由 `npm test` 校验）和
`tools/decrypt.mjs`（由 `npm run verify:vectors` 校验）。CI 会同时运行两者。向量只增不改——变更格式
意味着提升 `VERSION` 并追加用例，绝不修改已有用例。

---

## 变更检测的原理

Geode 通过比较文件**明文**的 SHA-256 与 `data.json` 中的本地索引来判断文件是否过期。

这件事比听起来更重要。加密文件每次推送都会得到新的 nonce，因此它们的密文——以及 Drive 的
`md5Checksum`——每次都会变，哪怕笔记本身没动。任何基于远端校验和的过期判断，都会导致每次运行都重新
上传整个仓库。明文哈希是唯一不会变动的信号。

远端 md5 只用于一件事：发现**另一台设备**在本机上次推送之后重写了该文件。那是冲突，Geode 拒绝
覆盖它。

明文哈希永远不会离开你的设备。为加密文件上传它，会让任何人都能验证对其内容的猜测。

值得了解的后果：

- Push 会读取仓库中的每个文件以计算哈希。这是正确的做法，但在有大量大附件的仓库上并不便宜。
- 丢失 `data.json` 不是灾难。下次推送会看到没有记录的文件，发现它们已经在 Drive 上，于是报告为
  冲突而不是覆盖。Pull 会重建索引。
- `.obsidian/` 永远不会被备份。`data.json` 就在那里，而其中存着你的 Google refresh token。

### Drive 上的存储布局

扁平结构。一个文件夹，仓库中每个文件对应一个 Drive 文件，不镜像目录层级：

```
Geode/
  bm90ZS5tZA                    ← base64url("note.md")
  Sm91cm5hbC8yMDI2LTA4LTAxLm1k  ← base64url("Journal/2026-08-01.md")
  __keycheck
```

路径之所以存放在文件名里，是因为 Drive 的 `appProperties` 每个键/值对上限约为 124 字节，任何非
ASCII 路径都会超出。`appProperties` 只携带 `{ v, enc }`。

每次上传都会显式指定该文件夹为父目录，因此 Geode 写入的任何内容都不可能落到别处——而且
`drive.file` 权限让插件根本看不到你 Drive 的其余部分。

文件夹创建在「我的云端硬盘」根目录，插件不提供选择其他位置的方式：在 `drive.file` 权限下它看不到
你的目录树，也就拿不到父目录的 id。如果你想把它放得整齐些，**在 Drive 网页端把它拖过去一次即可**。
Geode 通过 file id 定位该文件夹，所以移动对它是透明的；即便 `data.json` 丢失，回退查找也是按名称
搜索且不限定父目录，无论你把它放在哪里都能找到。

---

## 设置项参考

| 设置项                        | 默认值     | 说明                                           |
| ----------------------------- | ---------- | ---------------------------------------------- |
| Client ID / secret            | 空         | 你自己的 Google OAuth 客户端                   |
| Sign-in method                | Device     | 只有当 Google 拒绝 device flow 时才切换到 PKCE |
| Drive folder name             | `Geode`    | 推送之后再改，会指向另一个文件夹               |
| Encrypt selected paths        | 关闭       | 开启后启用下面的前缀列表                       |
| Encrypted paths               | 空         | 每行一个前缀                                   |
| Ask for the passphrase        | 每会话一次 | 或者每次推送和拉取都询问                       |
| **Mirror deletions to Drive** | **关闭**   | 开启后，本地删除会永久移除 Drive 上的副本      |

> **关于同步删除：** 关闭时，你在本地删除的文件仍然留在备份中——通常这正是做备份的意义所在。开启
> 后，推送会永久删除 Drive 上的副本，并绕过 Drive 回收站。一个会忘记你删过什么的备份，也就没法帮你
> 找回它。

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
  core/          纯逻辑：container、kdf、path-codec、selector、diff、bytes
  drive/         auth-provider、device-flow、pkce-flow、client、dto
  ops/           push、pull、index-store
  ui/            settings-tab、模态框、progress
test/            只针对 src/core 的 vitest——无 mock，无 Obsidian 桩
tools/           独立解密工具、向量生成器、版本号同步
```

有两条规则由构建流程强制执行，而不是靠约定：

- **`src/core/` 中的任何文件都不得导入 `obsidian`。** 所有 I/O 都从外部注入，正是这一点让加密逻辑
  和 diff 逻辑能在纯 Node 环境下无 mock 地测试。
- **`src/` 中的任何文件都不得触碰 Node API。** `tsconfig.json` 设置了 `types: []`，因此 `Buffer`、
  `process` 和 `require` 无法通过编译；ESLint 还会按名字禁止它们以及 `fetch`。所有 HTTP 都走
  Obsidian 的 `requestUrl`，那是渲染进程中唯一能绕过 CORS 的途径。

你可以自己试：在 `src/` 下的任意文件里写 `Buffer.from('x')`，`npm run typecheck` 和 `npm run lint`
都会拒绝它。

---

## 发布版本

两条命令：

```bash
npm version patch     # 或 minor / major
git push --follow-tags
```

`npm version` 会提升 `package.json` 中的版本号，随后 `version` 生命周期脚本同步 `manifest.json`
并向 `versions.json` 追加新条目，三个文件都会进入同一个版本提交。推送标签会触发
[`release.yml`](../.github/workflows/release.yml)：它重新运行类型检查、lint、测试和黄金向量校验，
构建 `main.js`，并发布带自动生成说明的 GitHub Release。

三个容易弄错、排查起来又很费时的细节：

- **标签不能带 `v` 前缀。** Obsidian 通过与 `manifest.json` 版本完全一致的标签来匹配发布，所以必须
  是 `1.2.3` 而不是 `v1.2.3`。[`.npmrc`](../.npmrc) 中设置了 `tag-version-prefix=""`，因此
  `npm version` 默认就会生成正确的标签。
- **附件要逐个上传，绝不能打包成 zip。** Obsidian 的安装器直接从发布页获取 `main.js` 和
  `manifest.json`；`.zip` 对它来说等于不存在。
- **`versions.json` 位于默认分支，而不在发布附件里。** 它把插件版本映射到最低 Obsidian 版本，正是
  靠它，旧客户端才会被推荐它们还能运行的最后一个版本。

如果标签与 `manifest.json`、`package.json` 或 `versions.json` 不一致，或者构建产物中出现了
Node API，workflow 会拒绝发布。这类出错的发布在 GitHub 上看起来一切正常，只是永远到不了用户手里。

要提高最低 Obsidian 版本，请在运行 `npm version` **之前**修改 `manifest.json` 中的
`minAppVersion`——版本脚本会把当时的值原样写入 `versions.json`。

---

## 许可证

[Apache-2.0](../LICENSE)
