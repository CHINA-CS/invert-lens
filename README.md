# 反色滤镜片 (Invert Lens)

桌面悬浮镜片工具：实时把白底变黑底、黑字变白字，彩色区域变为灰阶。适合长时间阅读白底网页、文档、PDF 时减轻刺眼。

![Electron](https://img.shields.io/badge/Electron-33-blue) ![Platform](https://img.shields.io/badge/platform-Windows-lightgrey) ![License](https://img.shields.io/badge/license-MIT-green)

## 功能

- **自由悬浮镜片**：置顶、可拖动、可八向缩放
- **滤镜模式**：仅反色 / 仅灰度 / 反色+灰度 / 关闭
- **自定义亮度**：工具栏滑杆按百分比降低镜片内画面亮度（10%–100%）
- **实时捕捉**：镜片区域随桌面内容实时更新
- **智能穿透**：
  - 顶栏：拖动移动镜片、点工具按钮
  - 边缘：缩放
  - 镜片中部：点击穿透，可直接操作下层窗口
- **多显示器**：镜片拖到哪块屏，就捕捉哪块屏
- **防闪烁**：窗口从截屏中排除自身（`contentProtection`），避免黑白正反馈
- **冻结模式**：一键定格当前画面（兜底，绝对不闪）
- **系统托盘** + 全局快捷键
- **后台唤出**：`Ctrl+Alt+C` 随时隐藏/唤出，可长期挂托盘
- **指针像素抹除**：截屏里的鼠标指针从镜片画面中盖掉，避免反色后出现「第二只鼠标」

## 快速开始

### 环境

- Windows 10/11
- Node.js 18+

### 安装依赖

```bash
npm install
```

> 若 Electron 二进制下载失败，可使用镜像：
> ```bash
> set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> npm install
> ```

### 运行

```bash
npm start
```

或双击 `启动镜片.bat`。

### 打包（可选）

```bash
npm install
npx electron-builder --win portable
```

产物在 `dist/` 目录。

### 便携版（推荐带走）

打包成功后可直接使用单文件：

```
dist/反色滤镜片 1.0.0.exe
```

- 拷到 U 盘 / 任意 Windows 电脑，双击即可运行  
- 无需安装 Node.js 或 npm  
- 首次运行可能解压到临时目录，属正常现象  
- 若杀毒软件误报，选择信任（未做代码签名）  

也可使用免安装文件夹：

```
dist/win-unpacked/反色滤镜片.exe
```

整个 `win-unpacked` 文件夹拷走同样可用。

## 使用说明

| 操作 | 方式 |
|------|------|
| 移动镜片 | 鼠标移到**顶部横杠**，按住拖动 |
| 缩放 | 鼠标贴近**四边/四角**，拖动手柄 |
| 操作下层内容 | 鼠标移到镜片**中部**，点击/滚动会穿透 |
| 切换滤镜模式 | `Ctrl+Shift+I` 或顶部「模式」按钮 |
| 调节亮度 | 顶部「亮度」滑杆（100% 原亮度，数值越低越暗） |
| 开关滤镜 | `Ctrl+Shift+E` 或顶部「滤镜」按钮 |
| 实时 / 冻结 | 顶部「实时」按钮切换 |
| 刷新冻结帧 | `Ctrl+Shift+R` 或顶部「刷新」 |
| **唤出 / 隐藏（后台）** | **`Ctrl+Alt+C`** |
| 隐藏 / 显示 | `Ctrl+Shift+H`（同 Z） |
| 退出 | 托盘右键「退出」或 `Ctrl+Shift+Q` |

## 交互逻辑

```
光标位置                 鼠标行为
─────────────────────────────────────
顶部拖拽条 (~28px)    →  接管（拖动 / 按钮 / 亮度）仅此条遮挡
四边 (~6px)           →  接管（缩放）
镜片其余区域          →  穿透到下层
```

由主进程约 40ms 轮询光标位置决定，不依赖不可靠的 `forward` 事件。

## 技术实现

- **Electron** 无边框置顶窗
- **屏幕捕获**：`desktopCapturer` + `getUserMedia(chromeMediaSource)`
- **滤镜**：CSS `filter: invert(1) grayscale(1)`
- **防自拍闪烁**：`win.setContentProtection(true)` 从系统截屏排除自身
- **多屏**：按镜片所在显示器 `display_id` 匹配捕获源
- **穿透**：`setIgnoreMouseEvents` 由光标轮询动态切换

## 项目结构

```
invert-lens/
├── main.js          # 主进程：窗口、托盘、快捷键、捕获源、光标轮询
├── preload.js       # contextBridge IPC
├── src/
│   ├── index.html
│   ├── styles.css
│   └── renderer.js  # 渲染层：滤镜、对齐、UI
├── assets/          # 图标
└── package.json
```

## License

MIT
