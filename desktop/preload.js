const { contextBridge, ipcRenderer } = require('electron');

// 只暴露只读的环境标识，供渲染层判断当前是否运行在桌面客户端内。
// 除此之外只开一个口子：把资产图拖出到资源管理器。
contextBridge.exposeInMainWorld('promptvaultDesktop', {
  isDesktop: true,
  platform: process.platform,
  versions: {
    app: '1.0.0',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  },

  /**
   * 把资产图原图拖出到系统（资源管理器 / 微信 / PS 等）。
   *
   * 为什么不用 HTML5 拖拽：卡片显示的是缩略图，拖 <img> 时 Chromium 会把
   * img.src（缩略图）预置成 dataTransfer 的 file 项，资源管理器取到的就是缩略图。
   * 试过 items.remove() 删掉它 —— 真实拖拽会话里会破坏 dataTransfer，直接拖失败。
   * 所以走 Electron 官方路径：主进程落临时文件 + webContents.startDrag，
   * 交给系统的是磁盘上的真实文件，任何目标都认。
   *
   * @param {string} fileName 目标文件名（带扩展名）
   * @param {string} mime MIME
   * @param {ArrayBuffer} data 原图字节
   * @param {ArrayBuffer|null} iconData 拖拽时跟随鼠标的小图标（用缩略图）
   */
  startDragAsset: (fileName, mime, data, iconData) =>
    ipcRenderer.invoke('pv:drag-asset', { fileName, mime, data, iconData })
});
