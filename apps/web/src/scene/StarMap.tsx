// ① 星区态势图（§7.3）。@pixi/react 只负责挂载 Application；场景在 ticker 里命令式驱动，不经过 React。
// 世界 1 Hz、画面 60 fps：无人机位置按「上次补丁到达后经过的时间」在航线上插值。
import { Application, useApplication } from '@pixi/react';
import { Container, Graphics, Text, type Application as PixiApp } from 'pixi.js';
import { useEffect, useRef } from 'react';
import { bezier, SECTOR_IDS, sectorCenterAngle, type DroneView, type Point, type Polar, type WorldSnapshot } from '@rescue/protocol';
import { useUi, useWorld } from '../store/index.ts';
import { SignalCard } from './SignalCard.tsx';

const COLORS = {
  ring: 0x22d3ee,
  signal: 0xfb923c,
  scanned: 0x67e8f9,
  judged: 0xfde68a,
  lost: 0x475569,
  rescued: 0x10b981,
  station: 0x22d3ee,
  drone: 0xe2e8f0,
  hazard: 0xf43f5e,
  flare: 0xfb7185,
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

const projectPoint = (p: Point, v: Viewport) => ({ x: v.cx + p.x * v.scale, y: v.cy - p.y * v.scale });

function viewportOf(w: number, h: number): Viewport {
  return { cx: w / 2, cy: h / 2, scale: Math.min(w, h) / 2 / 108 };
}

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** 当前的「小数 tick」：上次补丁之后按速率外推，最多外推一个 tick */
function fractionalTick(world: WorldSnapshot): number {
  const { receivedAt } = useWorld.getState();
  if (world.speed === 0 || world.ended) return world.tick;
  const elapsed = (performance.now() - receivedAt) / (1000 / world.speed);
  return world.tick + Math.min(1, Math.max(0, elapsed));
}

export function dronePoint(d: DroneView, ftick: number): Point {
  if (!d.route) return { x: Math.cos(d.pos.angle) * d.pos.radius, y: Math.sin(d.pos.angle) * d.pos.radius };
  const r = d.route;
  const t = Math.min(1, Math.max(0, (ftick - r.departTick) / Math.max(1, r.arriveTick - r.departTick)));
  return bezier(r, t);
}

/** 在扇环里画一圈（耀斑区） */
function wedge(g: Graphics, v: Viewport, center: number, inner = INNER, outer = OUTER) {
  const a0 = -(center + Math.PI / 6);
  const a1 = -(center - Math.PI / 6);
  g.moveTo(v.cx + Math.cos(a0) * inner * v.scale, v.cy + Math.sin(a0) * inner * v.scale);
  g.arc(v.cx, v.cy, outer * v.scale, a0, a1);
  g.arc(v.cx, v.cy, inner * v.scale, a1, a0, true);
  g.closePath();
}

function Scene() {
  const { app, isInitialised } = useApplication();

  useEffect(() => {
    if (!isInitialised) return;
    const stars = new Graphics();
    const statics = new Graphics();
    const flares = new Graphics();
    const labels = new Container();
    const dynamic = new Graphics();
    app.stage.addChild(stars, statics, flares, labels, dynamic);

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
    const droneLabels = new Map<string, Text>();
    const trails = new Map<string, Array<{ x: number; y: number; at: number }>>();

    let lastStaticKey = '';
    const drawStatic = (world: WorldSnapshot, v: Viewport) => {
      const key = `${app.screen.width}x${app.screen.height}|${world.modules.map((m) => m.status).join(',')}`;
      if (key === lastStaticKey) return;
      lastStaticKey = key;
      statics.clear();
      // 星区：6 个扇环，交替底色
      world.sectors.forEach((s, i) => {
        wedge(statics, v, s.angle);
        statics.fill({ color: COLORS.ring, alpha: i % 2 ? 0.025 : 0.045 });
        statics.stroke({ width: 1, color: COLORS.ring, alpha: 0.18 });
      });
      for (const r of [INNER, 55, 75, OUTER]) {
        statics.circle(v.cx, v.cy, r * v.scale).stroke({ width: 1, color: COLORS.ring, alpha: r === OUTER ? 0.35 : 0.12 });
      }
      // 站点：六边形 + 光晕
      statics.circle(v.cx, v.cy, 16 * v.scale).fill({ color: COLORS.station, alpha: 0.06 });
      const hex = Array.from({ length: 6 }, (_, k) => {
        const a = (Math.PI / 3) * k + Math.PI / 6;
        return [v.cx + Math.cos(a) * 7 * v.scale, v.cy + Math.sin(a) * 7 * v.scale];
      }).flat();
      statics.poly(hex).fill({ color: 0x0f172a }).stroke({ width: 1.5, color: COLORS.station, alpha: 0.9 });
      for (const { id, t } of sectorLabels) {
        const p = project({ angle: sectorCenterAngle(id), radius: OUTER + 7 }, v);
        t.position.set(p.x, p.y);
      }
    };

    const label = (map: Map<string, Text>, id: string, text: string, fill: number, size = 11) => {
      let t = map.get(id);
      if (!t) {
        t = new Text({ text, style: { fill, fontSize: size, fontFamily: 'JetBrains Mono' } });
        labels.addChild(t);
        map.set(id, t);
      }
      return t;
    };
    const prune = (map: Map<string, Text>, seen: Set<string>) => {
      for (const [id, t] of map) {
        if (!seen.has(id)) {
          t.destroy();
          map.delete(id);
        }
      }
    };

    const tick = () => {
      const world = useWorld.getState().world;
      if (!world) return;
      const v = viewportOf(app.screen.width, app.screen.height);
      const now = performance.now();
      const calm = reducedMotion();
      const ftick = fractionalTick(world);
      drawStatic(world, v);

      // 星空视差：三层不同速度
      stars.clear();
      const w = app.screen.width;
      const h = app.screen.height;
      for (const s of starfield) {
        const speed = calm ? 0 : (s.layer + 1) * 0.0000025;
        stars.circle(((s.x + now * speed) % 1) * w, s.y * h, s.size).fill({ color: 0xffffff, alpha: s.alpha * (0.6 + s.layer * 0.2) });
      }

      // 耀斑：预警时轮廓脉动，爆发时噪声缓慢流动
      flares.clear();
      for (const s of world.sectors) {
        if (s.hazard <= 0) continue;
        const pulse = calm ? 0.6 : 0.5 + 0.5 * Math.sin(now / 300);
        wedge(flares, v, s.angle);
        if (s.hazard < 1) {
          flares.fill({ color: COLORS.flare, alpha: 0.05 + 0.05 * pulse });
          flares.stroke({ width: 2, color: COLORS.flare, alpha: 0.35 + 0.4 * pulse });
          continue;
        }
        flares.fill({ color: COLORS.hazard, alpha: 0.16 });
        flares.stroke({ width: 1.5, color: COLORS.hazard, alpha: 0.7 });
        const frame = calm ? 0 : Math.floor(now / 140);
        let seed = (frame * 9301 + s.id.charCodeAt(0) * 49297) % 233280;
        const rnd = () => (seed = (seed * 9301 + 49297) % 233280) / 233280;
        for (let i = 0; i < 70; i++) {
          const r = INNER + 4 + rnd() * (OUTER - INNER - 8);
          const a = s.angle + (rnd() - 0.5) * (Math.PI / 3) * 0.95;
          const p = project({ angle: a, radius: r }, v);
          flares.circle(p.x, p.y, 1 + rnd() * 2.5).fill({ color: rnd() < 0.5 ? 0xfb923c : 0xfda4af, alpha: 0.25 + rnd() * 0.45 });
        }
      }

      dynamic.clear();
      const ui = useUi.getState();
      // 舱段告警：站点周围的四个状态点，受损时闪烁
      world.modules.forEach((m, k) => {
        const a = (Math.PI / 2) * k + Math.PI / 4;
        const color = m.status === 'ok' ? 0x10b981 : m.status === 'damaged' ? 0xf59e0b : 0xf43f5e;
        const blink = m.status === 'ok' || calm ? 1 : 0.4 + 0.6 * Math.abs(Math.sin(now / 220));
        dynamic.circle(v.cx + Math.cos(a) * 3.6 * v.scale, v.cy + Math.sin(a) * 3.6 * v.scale, 1.6 * v.scale).fill({ color, alpha: blink });
        if (m.repair) dynamic.circle(v.cx + Math.cos(a) * 3.6 * v.scale, v.cy + Math.sin(a) * 3.6 * v.scale, 2.6 * v.scale).stroke({ width: 1, color: 0x22d3ee, alpha: 0.8 });
      });
      // 扫描：扇形扫掠 + 外扩波纹
      for (const scan of world.scans) {
        const center = sectorCenterAngle(scan.sector);
        const span = Math.max(1, scan.endTick - scan.startTick);
        const progress = Math.min(1, Math.max(0, (ftick - scan.startTick) / span));
        const a0 = -(center + Math.PI / 6);
        const sweep = a0 + (Math.PI / 3) * (calm ? 1 : progress);
        dynamic.moveTo(v.cx, v.cy);
        dynamic.arc(v.cx, v.cy, OUTER * v.scale, a0, sweep);
        dynamic.closePath();
        dynamic.fill({ color: 0x22d3ee, alpha: 0.1 });
        const edge = project({ angle: -sweep, radius: OUTER }, v);
        dynamic.moveTo(v.cx, v.cy).lineTo(edge.x, edge.y).stroke({ width: 1.5, color: 0x67e8f9, alpha: 0.8 });
        if (!calm) {
          const ripple = ((now / 1400) % 1) * OUTER;
          const r0 = -(center + Math.PI / 6);
          dynamic.moveTo(v.cx + Math.cos(r0) * ripple * v.scale, v.cy + Math.sin(r0) * ripple * v.scale);
          dynamic.arc(v.cx, v.cy, ripple * v.scale, r0, -(center - Math.PI / 6)).stroke({ width: 1, color: 0x67e8f9, alpha: 0.5 * (1 - ripple / OUTER) });
        }
      }
      // 信号：同心脉冲，剩余时间越少频率越高；获救 / 诱饵 / 失联各有终态
      const seen = new Set<string>();
      for (const s of world.signals) {
        const p = project(s.pos, v);
        const live = s.status === 'active' || s.status === 'locked';
        const color = s.outcome === 'rescued' ? COLORS.rescued : !live ? COLORS.lost : s.clues.length ? COLORS.judged : s.scanned ? COLORS.scanned : COLORS.signal;
        const remaining = Math.max(0, s.expiresTick - world.tick);
        const urgency = live ? 1 - Math.min(1, remaining / 420) : 0;
        if (live && !calm) {
          const period = 2200 - urgency * 1500;
          for (let k = 0; k < 2; k++) {
            const phase = (now / period + k / 2) % 1;
            dynamic.circle(p.x, p.y, 4 + phase * 18).stroke({ width: 1.2, color, alpha: (1 - phase) * 0.7 });
          }
        }
        if (s.outcome === 'hoax') {
          dynamic.moveTo(p.x - 4, p.y - 4).lineTo(p.x + 4, p.y + 4).moveTo(p.x + 4, p.y - 4).lineTo(p.x - 4, p.y + 4).stroke({ width: 2, color: COLORS.lost });
        } else if (s.outcome === 'rescued') {
          dynamic.circle(p.x, p.y, 6).stroke({ width: 1.5, color: COLORS.rescued, alpha: 0.9 });
          dynamic.circle(p.x, p.y, 2.5).fill({ color: COLORS.rescued });
        } else {
          dynamic.circle(p.x, p.y, live ? 4 : 3).fill({ color, alpha: live ? 1 : 0.5 });
        }
        if (s.status === 'locked') {
          for (let k = 0; k < 8; k += 2) {
            const a0 = (k * Math.PI) / 4 + now / 600;
            dynamic.moveTo(p.x + Math.cos(a0) * 9, p.y + Math.sin(a0) * 9);
            dynamic.arc(p.x, p.y, 9, a0, a0 + Math.PI / 4).stroke({ width: 1.2, color: 0xe2e8f0, alpha: 0.8 });
          }
        }
        if (s.id === ui.selectedSignal) dynamic.circle(p.x, p.y, 12).stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 });
        seen.add(s.id);
        const t = label(signalLabels, s.id, s.id, 0xe2e8f0);
        t.position.set(p.x + 8, p.y - 16);
        t.alpha = live ? 0.85 : 0.3;
      }
      prune(signalLabels, seen);

      // 无人机：航线虚线、粒子拖尾、机体
      const seenDrones = new Set<string>();
      for (const d of world.drones) {
        seenDrones.add(d.id);
        const pt = projectPoint(dronePoint(d, ftick), v);
        const focused = !!d.correlationId && ui.focus === d.correlationId;
        if (d.route) {
          for (let i = 0; i < 30; i += 2) {
            const a = projectPoint(bezier(d.route, i / 30), v);
            const b = projectPoint(bezier(d.route, (i + 1) / 30), v);
            dynamic.moveTo(a.x, a.y).lineTo(b.x, b.y).stroke({ width: 1, color: d.route.hazardous ? COLORS.hazard : 0x94a3b8, alpha: focused ? 0.9 : 0.4 });
          }
          if (!calm) {
            const trail = trails.get(d.id) ?? [];
            const last = trail[trail.length - 1];
            if (!last || Math.hypot(last.x - pt.x, last.y - pt.y) > 1.5) trail.push({ ...pt, at: now });
            while (trail.length && now - trail[0].at > 1600) trail.shift();
            trails.set(d.id, trail);
            for (const tp of trail) {
              const age = (now - tp.at) / 1600;
              dynamic.circle(tp.x, tp.y, 2.2 * (1 - age) + 0.4).fill({ color: d.damaged ? 0xf59e0b : 0x67e8f9, alpha: 0.5 * (1 - age) });
            }
          }
        } else trails.delete(d.id);
        const heading = d.route ? (() => {
          const t = Math.min(1, Math.max(0, (ftick - d.route.departTick) / Math.max(1, d.route.arriveTick - d.route.departTick)));
          const a = bezier(d.route, Math.max(0, t - 0.02));
          const b = bezier(d.route, Math.min(1, t + 0.02));
          return Math.atan2(-(b.y - a.y), b.x - a.x);
        })() : -Math.PI / 2;
        const size = d.route ? 5 : 3.5;
        const tri = [0, -1.1, 0.8, 0.9, -0.8, 0.9].map((c, i) => c * size);
        const cos = Math.cos(heading + Math.PI / 2);
        const sin = Math.sin(heading + Math.PI / 2);
        const pts: number[] = [];
        for (let i = 0; i < 6; i += 2) pts.push(pt.x + tri[i] * cos - tri[i + 1] * sin, pt.y + tri[i] * sin + tri[i + 1] * cos);
        dynamic.poly(pts).fill({ color: d.status === 'repairing' ? 0xf59e0b : d.damaged ? 0xfbbf24 : COLORS.drone, alpha: 0.95 });
        if (focused) dynamic.circle(pt.x, pt.y, 10).stroke({ width: 1.5, color: 0xffffff });
        const dl = label(droneLabels, d.id, d.id, 0xcbd5e1, 10);
        dl.position.set(pt.x + 7, pt.y + 2);
        dl.alpha = d.route ? 0.9 : 0;
      }
      prune(droneLabels, seenDrones);
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
    const v = viewportOf(rect.width, rect.height);
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    // 先点无人机：联动到下达这次出动的工具调用（地图 → Inspector → 频道共享 toolCallId）
    const ftick = fractionalTick(world);
    for (const d of world.drones) {
      if (!d.route || !d.correlationId) continue;
      const p = projectPoint(dronePoint(d, ftick), v);
      if (Math.hypot(p.x - x, p.y - y) < 14) {
        useUi.setState({ focus: d.correlationId, selectedSignal: d.targetSignalId });
        return;
      }
    }
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
