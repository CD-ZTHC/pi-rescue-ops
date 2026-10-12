// ① 星区态势图（§7.3）。@pixi/react 只负责挂载 Application；场景在 ticker 里命令式驱动，不经过 React。
import { Application, useApplication } from '@pixi/react';
import { Container, Graphics, Text, type Application as PixiApp } from 'pixi.js';
import { useEffect, useRef } from 'react';
import { SECTOR_IDS, sectorCenterAngle, type Polar, type WorldSnapshot } from '@rescue/protocol';
import { useUi, useWorld } from '../store/index.ts';
import { SignalCard } from './SignalCard.tsx';

const COLORS = {
  ring: 0x22d3ee,
  signal: 0xfb923c,
  scanned: 0x67e8f9,
  lost: 0x475569,
  station: 0x22d3ee,
  drone: 0xe2e8f0,
  hazard: 0xf43f5e,
};
const INNER = 30;
const OUTER = 95;

export interface Viewport {
  cx: number;
  cy: number;
  scale: number;
}

export function project(p: Polar, v: Viewport): { x: number; y: number } {
  return { x: v.cx + Math.cos(p.angle) * p.radius * v.scale, y: v.cy - Math.sin(p.angle) * p.radius * v.scale };
}

function viewportOf(app: PixiApp): Viewport {
  const w = app.screen.width;
  const h = app.screen.height;
  return { cx: w / 2, cy: h / 2, scale: Math.min(w, h) / 2 / 108 };
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

function Scene() {
  const { app, isInitialised } = useApplication();

  useEffect(() => {
    if (!isInitialised) return;
    const stars = new Graphics();
    const statics = new Graphics();
    const labels = new Container();
    const dynamic = new Graphics();
    app.stage.addChild(stars, statics, labels, dynamic);

    const starfield = Array.from({ length: 160 }, (_, i) => ({
      x: Math.random(),
      y: Math.random(),
      layer: i % 3,
      size: 0.4 + Math.random() * 1.1,
      alpha: 0.15 + Math.random() * 0.5,
    }));
    const sectorLabels = SECTOR_IDS.map((id) => {
      const t = new Text({ text: id, style: { fill: 0x67e8f9, fontSize: 13, fontFamily: 'JetBrains Mono', fontWeight: '600' } });
      t.anchor.set(0.5);
      t.alpha = 0.7;
      labels.addChild(t);
      return { id, t };
    });
    const signalLabels = new Map<string, Text>();

    let lastStaticKey = '';
    const drawStatic = (world: WorldSnapshot, v: Viewport) => {
      const key = `${app.screen.width}x${app.screen.height}|${world.sectors.map((s) => s.hazard).join(',')}|${world.modules.map((m) => m.status).join(',')}`;
      if (key === lastStaticKey) return;
      lastStaticKey = key;
      statics.clear();
      // 星区：6 个扇环，交替底色，危险度用红色叠加
      world.sectors.forEach((s, i) => {
        const a0 = -(s.angle + Math.PI / 6);
        const a1 = -(s.angle - Math.PI / 6);
        statics.moveTo(v.cx + Math.cos(a0) * INNER * v.scale, v.cy + Math.sin(a0) * INNER * v.scale);
        statics.arc(v.cx, v.cy, OUTER * v.scale, a0, a1);
        statics.arc(v.cx, v.cy, INNER * v.scale, a1, a0, true);
        statics.closePath();
        statics.fill({ color: s.hazard > 0 ? COLORS.hazard : COLORS.ring, alpha: s.hazard > 0 ? 0.06 + s.hazard * 0.18 : i % 2 ? 0.025 : 0.045 });
        statics.stroke({ width: 1, color: COLORS.ring, alpha: 0.18 });
      });
      for (const r of [INNER, 55, 75, OUTER]) {
        statics.circle(v.cx, v.cy, r * v.scale).stroke({ width: 1, color: COLORS.ring, alpha: r === OUTER ? 0.35 : 0.12 });
      }
      // 站点：六边形 + 光晕；四个舱段的状态点
      statics.circle(v.cx, v.cy, 16 * v.scale).fill({ color: COLORS.station, alpha: 0.06 });
      const hex = Array.from({ length: 6 }, (_, k) => {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        return [v.cx + Math.cos(a) * 7 * v.scale, v.cy + Math.sin(a) * 7 * v.scale];
      }).flat();
      statics.poly(hex).fill({ color: 0x0f172a }).stroke({ width: 1.5, color: COLORS.station, alpha: 0.9 });
      world.modules.forEach((m, k) => {
        const a = (Math.PI / 2) * k + Math.PI / 4;
        const color = m.status === 'ok' ? 0x10b981 : m.status === 'damaged' ? 0xf59e0b : 0xf43f5e;
        statics.circle(v.cx + Math.cos(a) * 3.6 * v.scale, v.cy + Math.sin(a) * 3.6 * v.scale, 1.6 * v.scale).fill({ color });
      });
      for (const { id, t } of sectorLabels) {
        const p = project({ angle: sectorCenterAngle(id), radius: OUTER + 7 }, v);
        t.position.set(p.x, p.y);
      }
    };

    const tick = () => {
      const world = useWorld.getState().world;
      if (!world) return;
      const v = viewportOf(app);
      const now = performance.now();
      const calm = reducedMotion();
      drawStatic(world, v);

      // 星空视差：三层不同速度
      stars.clear();
      const w = app.screen.width;
      const h = app.screen.height;
      for (const s of starfield) {
        const speed = calm ? 0 : (s.layer + 1) * 0.0000025;
        const x = ((s.x + now * speed) % 1) * w;
        stars.circle(x, s.y * h, s.size).fill({ color: 0xffffff, alpha: s.alpha * (0.6 + s.layer * 0.2) });
      }

      dynamic.clear();
      const selected = useUi.getState().selectedSignal;
      // 扫描：扇形扫掠 + 外扩波纹
      for (const scan of world.scans) {
        const center = sectorCenterAngle(scan.sector);
        const span = Math.max(1, scan.endTick - scan.startTick);
        const progress = Math.min(1, Math.max(0, (world.tick - scan.startTick + (now % 1000) / 1000) / span));
        const sweep = -(center + Math.PI / 6) + (Math.PI / 3) * (calm ? 1 : progress);
        const a0 = -(center + Math.PI / 6);
        dynamic.moveTo(v.cx, v.cy);
        dynamic.arc(v.cx, v.cy, OUTER * v.scale, a0, sweep);
        dynamic.closePath();
        dynamic.fill({ color: 0x22d3ee, alpha: 0.1 });
        const edge = project({ angle: -sweep, radius: OUTER }, v);
        dynamic.moveTo(v.cx, v.cy).lineTo(edge.x, edge.y).stroke({ width: 1.5, color: 0x67e8f9, alpha: 0.8 });
        if (!calm) {
          const ripple = ((now / 1400) % 1) * OUTER;
          dynamic.arc(v.cx, v.cy, ripple * v.scale, -(center + Math.PI / 6), -(center - Math.PI / 6)).stroke({ width: 1, color: 0x67e8f9, alpha: 0.5 * (1 - ripple / OUTER) });
        }
      }
      // 信号：同心脉冲，剩余时间越少频率越高
      const seen = new Set<string>();
      for (const s of world.signals) {
        const p = project(s.pos, v);
        const active = s.status === 'active';
        const color = !active ? COLORS.lost : s.clues.length ? COLORS.scanned : COLORS.signal;
        const remaining = Math.max(0, s.expiresTick - world.tick);
        const urgency = active ? 1 - Math.min(1, remaining / 420) : 0;
        if (active && !calm) {
          const period = 2200 - urgency * 1500;
          for (let k = 0; k < 2; k++) {
            const phase = ((now / period + k / 2) % 1);
            dynamic.circle(p.x, p.y, 4 + phase * 18).stroke({ width: 1.2, color, alpha: (1 - phase) * 0.7 });
          }
        }
        dynamic.circle(p.x, p.y, active ? 4 : 3).fill({ color, alpha: active ? 1 : 0.6 });
        if (s.id === selected) dynamic.circle(p.x, p.y, 11).stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });
        seen.add(s.id);
        let label = signalLabels.get(s.id);
        if (!label) {
          label = new Text({ text: s.id, style: { fill: 0xe2e8f0, fontSize: 11, fontFamily: 'JetBrains Mono' } });
          labels.addChild(label);
          signalLabels.set(s.id, label);
        }
        label.position.set(p.x + 8, p.y - 16);
        label.alpha = active ? 0.85 : 0.35;
      }
      for (const [id, label] of signalLabels) {
        if (!seen.has(id)) {
          label.destroy();
          signalLabels.delete(id);
        }
      }
      // 无人机（M1 只在港）
      for (const d of world.drones) {
        const p = project(d.pos, v);
        dynamic.poly([p.x, p.y - 4, p.x + 3.5, p.y + 3, p.x - 3.5, p.y + 3]).fill({ color: COLORS.drone, alpha: 0.9 });
      }
    };
    app.ticker.add(tick);
    return () => {
      app.ticker.remove(tick);
      app.stage.removeChildren().forEach((c) => c.destroy({ children: true }));
    };
  }, [app, isInitialised]);

  return null;
}

export function StarMap() {
  const ref = useRef<HTMLDivElement>(null);
  const pick = (e: React.MouseEvent<HTMLDivElement>) => {
    const world = useWorld.getState().world;
    const el = ref.current;
    if (!world || !el) return;
    const rect = el.getBoundingClientRect();
    const v = { cx: rect.width / 2, cy: rect.height / 2, scale: Math.min(rect.width, rect.height) / 2 / 108 };
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let best: { id: string; d: number } | undefined;
    for (const s of world.signals) {
      const p = project(s.pos, v);
      const d = Math.hypot(p.x - x, p.y - y);
      if (d < 16 && (!best || d < best.d)) best = { id: s.id, d };
    }
    useUi.setState({ selectedSignal: best?.id });
  };
  return (
    <div ref={ref} className="absolute inset-0 cursor-crosshair" onClick={pick}>
      <Application resizeTo={ref} background="#060b18" backgroundAlpha={0} antialias autoDensity resolution={window.devicePixelRatio || 1}>
        <Scene />
      </Application>
      <SignalCard />
    </div>
  );
}
