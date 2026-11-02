# PromptVault · Windows 桌面版

[PromptVault 图片提示词管理台](../README.md) 的 Electron 封装。渲染层与网页版共用同一套代码，
只是用桌面窗口替代了「浏览器 + 本地服务」。

> 桌面版不需要 Python、不需要 `start.bat`、不需要浏览器。

---

## 下载

| 文件 | 说明 |
| --- | --- |
| [PromptVault-1.1.6-portable.exe](https://github.com/liao942287300-cyber/prompt-vault/releases/latest/download/PromptVault-1.1.6-portable.exe) | 便携版，95.5 MB，双击运行，不写注册表 |

全部版本见 [Releases](https://github.com/liao942287300-cyber/prompt-vault/releases)。

---

## 和网页版的区别

| 能力 | 网页版 | 桌面版 |
| --- | --- | --- |
| 启动方式 | `start.bat` 起本地服务 | 双击 exe |
| 数据存储 | 浏览器 IndexedDB | Electron `userData` |
| 导出文件 | 下载到浏览器默认目录 | 系统保存对话框，可选路径 |
| 单实例 | 否 | 是，重复双击只聚焦已有窗口 |
| 窗口状态记忆 | 无 | 大小、位置、最大化状态 |

**数据不互通** —— 两边的 IndexedDB 是各自独立的存储。迁移方法见下。

---

## 从源码打包

```bash
cd desktop
npm install
npm run build
```

`npm run build` 依次执行：

1. `npm run sync` —— 把上一级（网页版源码）同步到 `renderer/`
2. `npm run icon` —— 用纯 Python 标准库生成 `build/icon.ico`（不需要 Pillow）
3. `electron-builder --win --x64` —— 产出 NSIS 安装包 + 便携版

产物在 `dist/`。

### 开发模式

```bash
npm run dev
```

先同步渲染层，再启动 Electron 窗口。开发时渲染层**直接指向上一级目录**，
改完网页代码刷新窗口就能看到变化，不用重新同步。

### 只打包便携版

```bash
npm run build:portable
```

### 关于 `.npmrc`

仓库里带了淘宝镜像配置（electron 和 electron-builder 的二进制都走 npmmirror）。
如果你在海外或公司内网有代理，删掉 `.npmrc` 或改成自己的源。

---

## 从网页版迁移数据

1. 网页版点「导出」→「整库 JSON 备份」，保存 `.json`
2. 打开桌面版
3. 点「导入」→「导入 JSON 备份」，选中刚才的文件

> 建议即使只用桌面版，也定期做一次整库备份 —— 卸载应用、清理用户数据或换电脑时，这是唯一的恢复手段。

---

## 数据存在哪里

Electron 的 `userData` 目录，Windows 上通常是：

```
%APPDATA%\PromptVault\
```

里面包含 IndexedDB、窗口状态等。**删除该目录会清空所有图库数据。**

---

## 实现要点

- **加载方式**：自定义 `app://local` 协议（standard + secure），避免 `file://` 加载 ES Module 被同源策略拦截；IndexedDB 在 `app://local` 来源下可正常持久化
- **桌面增强**：单实例锁、窗口大小 / 位置 / 最大化状态记忆、中文应用菜单、导出时系统保存对话框、渲染进程崩溃提示
- **图标**：纯 Python 标准库生成 `build/icon.ico`

---

## 已知限制

- 只测了 Windows（win32 x64），macOS / Linux 未打包
- 桌面版与网页版数据不互通，迁移必须走 JSON 备份
- `renderer/` 是构建产物，不要直接改 —— 每次 `npm run sync` 都会覆盖
