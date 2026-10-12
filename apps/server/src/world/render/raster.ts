// 最小光栅：填充、圆、线、矩形。M2 的雷达 / 监控 / 体征图在此基础上绘制。
import { encodePng } from './png.ts';

export type Rgb = readonly [number, number, number];

/** 渲染器保证图片 ≥64px（网关对 8px 图片返回 1210，§10） */
export const MIN_SIDE = 64;

export class Raster {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;

  constructor(width: number, height: number, background: Rgb = [6, 11, 24]) {
    if (width < MIN_SIDE || height < MIN_SIDE) throw new Error(`图片边长必须 ≥ ${MIN_SIDE}px`);
    this.width = width;
    this.height = height;
    this.data = new Uint8Array(width * height * 4);
    this.fill(background);
  }

  fill([r, g, b]: Rgb): void {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = r;
      this.data[i + 1] = g;
      this.data[i + 2] = b;
      this.data[i + 3] = 255;
    }
  }

  /** alpha 混合写一个像素 */
  plot(x: number, y: number, [r, g, b]: Rgb, alpha = 1): void {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= this.width || yi >= this.height) return;
    const i = (yi * this.width + xi) * 4;
    const a = Math.max(0, Math.min(1, alpha));
    this.data[i] = this.data[i] * (1 - a) + r * a;
    this.data[i + 1] = this.data[i + 1] * (1 - a) + g * a;
    this.data[i + 2] = this.data[i + 2] * (1 - a) + b * a;
  }

  /** 实心圆，边缘做 1px 抗锯齿 */
  circle(cx: number, cy: number, radius: number, color: Rgb, alpha = 1): void {
    for (let y = Math.floor(cy - radius - 1); y <= Math.ceil(cy + radius + 1); y++) {
      for (let x = Math.floor(cx - radius - 1); x <= Math.ceil(cx + radius + 1); x++) {
        const d = Math.hypot(x - cx, y - cy);
        const cover = Math.max(0, Math.min(1, radius + 0.5 - d));
        if (cover > 0) this.plot(x, y, color, alpha * cover);
      }
    }
  }

  ring(cx: number, cy: number, radius: number, color: Rgb, alpha = 1): void {
    const steps = Math.max(32, Math.ceil(radius * 8));
    for (let i = 0; i < steps; i++) {
      const t = (i / steps) * Math.PI * 2;
      this.plot(cx + Math.cos(t) * radius, cy + Math.sin(t) * radius, color, alpha);
    }
  }

  line(x0: number, y0: number, x1: number, y1: number, color: Rgb, alpha = 1): void {
    const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
    for (let i = 0; i <= steps; i++) this.plot(x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps, color, alpha);
  }

  rect(x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
    for (let yy = Math.floor(y); yy < y + h; yy++) for (let xx = Math.floor(x); xx < x + w; xx++) this.plot(xx, yy, color, alpha);
  }

  toPng(): Buffer {
    return encodePng(this.width, this.height, this.data);
  }

  toBase64(): string {
    return this.toPng().toString('base64');
  }
}
