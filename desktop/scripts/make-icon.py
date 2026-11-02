#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成 PromptVault 桌面客户端图标。

设计：靛蓝→紫渐变圆角底 + 三张错位叠放的白色卡片 + 卡片上的提示词横线，
呼应「提示词库 / 层叠素材」的产品含义。

产物：
    build/icon.ico          多尺寸 Windows 图标（16 / 24 / 32 / 48 / 64 / 128 / 256）
    build/icon-preview.png  256px 预览图

依赖 Pillow：
    pip install Pillow
"""

import io
import os
import struct
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.stderr.write(
        '缺少 Pillow，请先安装：\n'
        '    pip install Pillow\n'
        '（或 python -m pip install Pillow）\n'
    )
    sys.exit(1)

BASE = 256          # 逻辑尺寸
SS = 4              # 超采样倍数：先画大图再缩小，边缘更干净
S = BASE * SS

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build')
OUT_ICO = os.path.join(OUT_DIR, 'icon.ico')
OUT_PNG = os.path.join(OUT_DIR, 'icon-preview.png')

# 配色
C_FROM = (99, 102, 241)      # #6366F1 靛蓝
C_TO = (139, 92, 246)        # #8B5CF6 紫罗兰
LINE = (109, 40, 217)        # #6D28D9 卡片上的提示词线条
WHITE = (255, 255, 255)

ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]


def u(v):
    """逻辑单位 → 画布像素"""
    return int(round(v * SS))


def linear_gradient(size, c1, c2):
    """45° 线性渐变。先画小图再双三次放大，避免逐像素扫大画布。"""
    n = 64
    small = Image.new('RGB', (n, n))
    px = small.load()
    for y in range(n):
        for x in range(n):
            t = (x + y) / (2 * (n - 1))
            px[x, y] = tuple(int(c1[i] + (c2[i] - c1[i]) * t) for i in range(3))
    return small.resize((size, size), Image.BICUBIC)


def rounded_mask(size, radius):
    """圆角矩形遮罩"""
    mask = Image.new('L', (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [0, 0, size - 1, size - 1], radius=radius, fill=255
    )
    return mask


def card_layer(cx, cy, w, h, radius, fill):
    """在独立图层上画一张卡片，便于带透明度叠加"""
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    x0, y0 = cx - w // 2, cy - h // 2
    ImageDraw.Draw(layer).rounded_rectangle(
        [x0, y0, x0 + w, y0 + h], radius=radius, fill=fill
    )
    return layer


def draw_icon(detail=True):
    """
    绘制图标画布。
    @param detail 是否绘制卡片上的提示词线条（小尺寸下关掉，避免糊成一团）
    """
    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    # 1. 渐变圆角底
    grad = linear_gradient(S, C_FROM, C_TO).convert('RGBA')
    canvas.paste(grad, (0, 0), rounded_mask(S, u(56)))

    # 2. 三张叠放的卡片（后 → 前）
    cw, ch, r = u(132), u(164), u(20)
    cx, cy = S // 2, S // 2
    canvas.alpha_composite(card_layer(cx + u(17), cy - u(17), cw, ch, r, WHITE + (66,)))
    canvas.alpha_composite(card_layer(cx + u(9), cy - u(9), cw, ch, r, WHITE + (128,)))
    canvas.alpha_composite(card_layer(cx, cy, cw, ch, r, WHITE + (255,)))

    # 3. 卡片上的提示词横线（左对齐、长度递减）
    if detail:
        d = ImageDraw.Draw(canvas)
        left = cx - cw // 2 + u(26)
        top = cy - ch // 2 + u(42)
        for i, width in enumerate((u(80), u(64), u(48))):
            y = top + i * u(32)
            d.rounded_rectangle(
                [left, y, left + width, y + u(16)], radius=u(8), fill=LINE
            )

    return canvas


def draw_small_icon():
    """
    小尺寸（16 / 24）专用：去掉叠层、加大卡片、两条粗线。
    这些细节在 16px 下根本分辨不出来，简化后反而更清楚。
    """
    canvas = Image.new('RGBA', (S, S), (0, 0, 0, 0))

    grad = linear_gradient(S, C_FROM, C_TO).convert('RGBA')
    canvas.paste(grad, (0, 0), rounded_mask(S, u(56)))

    cx, cy = S // 2, S // 2
    cw, ch = u(150), u(182)
    layer = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(layer).rounded_rectangle(
        [cx - cw // 2, cy - ch // 2, cx + cw // 2, cy + ch // 2],
        radius=u(24), fill=WHITE + (255,)
    )
    canvas.alpha_composite(layer)

    d = ImageDraw.Draw(canvas)
    left = cx - cw // 2 + u(30)
    for i, width in enumerate((u(90), u(62))):
        y = cy - u(29) + i * u(34)
        d.rounded_rectangle([left, y, left + width, y + u(24)], radius=u(12), fill=LINE)

    return canvas


def build_ico(frames):
    """
    手工封装多尺寸 ICO（每个尺寸内嵌 PNG）。
    这样 16 / 24 这类小尺寸可以用简化版画面，不必和大图共用一套细节。
    """
    header = struct.pack('<HHH', 0, 1, len(frames))
    entries = b''
    payload = b''
    offset = 6 + 16 * len(frames)

    for size, img in frames:
        bio = io.BytesIO()
        img.save(bio, format='PNG')
        data = bio.getvalue()
        # 宽高字段各 1 字节，256 记作 0
        dim = 0 if size >= 256 else size
        entries += struct.pack('<BBBBHHII', dim, dim, 0, 0, 1, 32, len(data), offset)
        payload += data
        offset += len(data)

    with open(OUT_ICO, 'wb') as f:
        f.write(header + entries + payload)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)

    full = draw_icon(detail=True)
    small = draw_small_icon()

    frames = []
    for size in ICO_SIZES:
        # 小尺寸用简化版，避免细节糊成一团
        src = small if size <= 24 else full
        frames.append((size, src.resize((size, size), Image.LANCZOS)))

    build_ico(frames)
    full.resize((256, 256), Image.LANCZOS).save(OUT_PNG)

    print('已生成 %s（%s）' % (
        os.path.relpath(OUT_ICO),
        ', '.join(str(s) for s in ICO_SIZES)
    ))
    print('已生成 %s' % os.path.relpath(OUT_PNG))


if __name__ == '__main__':
    main()
