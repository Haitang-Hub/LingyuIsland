#!/bin/bash
# 灵屿岛 —— macOS 启动脚本
# 首次使用请先赋权：chmod +x 启动灵屿岛.command
cd "$(dirname "$0")" || exit 1

ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"

if [ ! -f "$ELECTRON_BIN" ]; then
  echo "[灵屿岛] 未找到 Electron 运行时，请先在本目录执行: npm install"
  read -r -p "按回车键关闭..." _
  exit 1
fi

exec "$ELECTRON_BIN" .
