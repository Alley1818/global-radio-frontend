import { useEffect, useRef, useState } from "react";
import { geoDistance, geoGraticule10, geoOrthographic, geoPath } from "d3-geo";
import { feature, mesh } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import worldData from "world-atlas/countries-110m.json";
import type { GeoPoint } from "./geo";

const topology = worldData as unknown as Topology;
const countries = topology.objects.countries as GeometryCollection;
const land = feature(topology, countries);
const borders = mesh(topology, countries, (a, b) => a !== b);
const graticule = geoGraticule10();

interface GlobeProps {
  points: GeoPoint[];
  total: number;
  activeId: string | null;
  playing: boolean;
  onSelect: (id: string) => void;
}

interface Hit {
  id: string;
  x: number;
  y: number;
}

interface HoverState {
  point: GeoPoint;
  x: number;
  y: number;
}

interface ViewState {
  rot: [number, number];
  target: [number, number] | null;
  zoom: number;
  zoomTarget: number;
  lastInteraction: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export default function Globe({ points, total, activeId, playing, onSelect }: GlobeProps) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);

  const live = useRef({ points, activeId, playing, onSelect });
  useEffect(() => {
    live.current = { points, activeId, playing, onSelect };
  });

  const view = useRef<ViewState>({
    rot: [-10, -28],
    target: null,
    zoom: 1,
    zoomTarget: 1,
    lastInteraction: 0,
  });
  const hoverIdRef = useRef<string | null>(null);
  const draggingRef = useRef<boolean>(false);

  // Фокус на активной станции
  useEffect(() => {
    const v = view.current;
    const point = points.find((p) => p.id === activeId);
    if (point) {
      v.target = [-point.lon, clamp(-point.lat, -75, 75)];
      v.zoomTarget = Math.max(v.zoomTarget, 2.4);
    } else {
      v.zoomTarget = 1;
    }
  }, [activeId, points]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const css = getComputedStyle(document.documentElement);
    const signal = css.getPropertyValue("--signal").trim() || "#ff9e40";
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const v = view.current;
    const projection = geoOrthographic().clipAngle(90).precision(0.6);
    const path = geoPath(projection, ctx);

    let width = 0;
    let height = 0;
    let dpr = 1;
    let currentScale = 1;
    let hits: Hit[] = [];
    let raf = 0;
    let last = performance.now();

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      width = stage.clientWidth;
      height = stage.clientHeight;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
    };

    const normalizeLon = () => {
      if (v.rot[0] > 180) v.rot[0] -= 360;
      if (v.rot[0] < -180) v.rot[0] += 360;
    };

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (width === 0 || height === 0) return;

      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const { points: pts, activeId: aid, playing: isPlaying } = live.current;
      const k = reduced ? 1 : 1 - Math.exp(-dt * 7);

      v.zoom += (v.zoomTarget - v.zoom) * k;

      if (v.target) {
        const dl = ((v.target[0] - v.rot[0] + 540) % 360) - 180;
        const dp = v.target[1] - v.rot[1];
        v.rot[0] += dl * k;
        v.rot[1] += dp * k;
        normalizeLon();
        if (Math.abs(dl) < 0.05 && Math.abs(dp) < 0.05) v.target = null;
      } else if (
        !reduced &&
        !draggingRef.current &&
        hoverIdRef.current === null &&
        !aid &&
        now - v.lastInteraction > 2500
      ) {
        v.rot[0] -= 4 * dt;
        normalizeLon();
      }

      const cx = width / 2;
      const cy = height / 2;
      const radius = Math.max(10, Math.min(width, height) / 2 - 10);
      currentScale = radius * v.zoom;

      projection.scale(currentScale).translate([cx, cy]).rotate([v.rot[0], v.rot[1]]);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);

      // Шар
      const grad = ctx.createRadialGradient(
        cx - currentScale * 0.35,
        cy - currentScale * 0.35,
        currentScale * 0.1,
        cx,
        cy,
        currentScale
      );
      grad.addColorStop(0, "#1a1d23");
      grad.addColorStop(1, "#0a0b0d");
      ctx.beginPath();
      path({ type: "Sphere" });
      ctx.fillStyle = grad;
      ctx.fill();

      ctx.save();
      ctx.shadowColor = "rgba(255, 158, 64, 0.28)";
      ctx.shadowBlur = 26;
      ctx.strokeStyle = "rgba(255, 158, 64, 0.35)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      path({ type: "Sphere" });
      ctx.stroke();
      ctx.restore();

      // Сетка, суша, границы
      ctx.beginPath();
      path(graticule);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
      ctx.lineWidth = 0.6;
      ctx.stroke();

      ctx.beginPath();
      path(land);
      ctx.fillStyle = "#262a32";
      ctx.fill();

      ctx.beginPath();
      path(borders);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
      ctx.lineWidth = 0.5;
      ctx.stroke();

      // Станции
      const center: [number, number] = [-v.rot[0], -v.rot[1]];
      const visible: { point: GeoPoint; x: number; y: number }[] = [];
      for (const point of pts) {
        const coords: [number, number] = [point.lon, point.lat];
        if (geoDistance(coords, center) > Math.PI / 2 - 0.03) continue;
        const xy = projection(coords);
        if (!xy) continue;
        visible.push({ point, x: xy[0], y: xy[1] });
      }

      hits = visible.map((item) => ({ id: item.point.id, x: item.x, y: item.y }));

      let active: { point: GeoPoint; x: number; y: number } | null = null;
      ctx.fillStyle = signal;
      for (const item of visible) {
        if (item.point.id === aid) {
          active = item;
          continue;
        }
        const isHover = item.point.id === hoverIdRef.current;
        ctx.globalAlpha = item.point.approx && !isHover ? 0.6 : 1;
        ctx.beginPath();
        ctx.arc(item.x, item.y, isHover ? 5.5 : 3.2, 0, Math.PI * 2);
        ctx.fill();
        if (isHover) {
          ctx.strokeStyle = signal;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.arc(item.x, item.y, 9, 0, Math.PI * 2);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      if (active) {
        if (isPlaying) {
          const phase = (now / 1600) % 1;
          ctx.strokeStyle = signal;
          ctx.globalAlpha = (1 - phase) * 0.7;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(active.x, active.y, 7 + phase * 16, 0, Math.PI * 2);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }
        ctx.fillStyle = "#fbfbfb";
        ctx.strokeStyle = signal;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(active.x, active.y, 5.5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
    };

    // Взаимодействие
    const localXY = (e: PointerEvent): [number, number] => {
      const rect = canvas.getBoundingClientRect();
      return [e.clientX - rect.left, e.clientY - rect.top];
    };

    const findHit = (x: number, y: number, maxDist: number): Hit | null => {
      let best: Hit | null = null;
      let bestDist = maxDist * maxDist;
      for (const hit of hits) {
        const d = (hit.x - x) ** 2 + (hit.y - y) ** 2;
        if (d <= bestDist) {
          bestDist = d;
          best = hit;
        }
      }
      return best;
    };

    const updateHover = (hit: Hit | null) => {
      const id = hit ? hit.id : null;
      if (id === hoverIdRef.current) return;
      hoverIdRef.current = id;
      const point = hit ? live.current.points.find((p) => p.id === hit.id) : undefined;
      setHover(hit && point ? { point, x: hit.x, y: hit.y } : null);
      canvas.style.cursor = hit ? "pointer" : "grab";
    };

    let moved = 0;
    let lastX = 0;
    let lastY = 0;

    const onDown = (e: PointerEvent) => {
      draggingRef.current = true;
      moved = 0;
      [lastX, lastY] = localXY(e);
      canvas.setPointerCapture(e.pointerId);
      v.target = null;
      v.lastInteraction = performance.now();
      updateHover(null);
      canvas.style.cursor = "grabbing";
    };

    const onMove = (e: PointerEvent) => {
      const [x, y] = localXY(e);
      if (draggingRef.current) {
        const dx = x - lastX;
        const dy = y - lastY;
        lastX = x;
        lastY = y;
        moved += Math.abs(dx) + Math.abs(dy);
        const degPerPx = 180 / Math.PI / currentScale;
        v.rot[0] += dx * degPerPx;
        v.rot[1] = clamp(v.rot[1] - dy * degPerPx, -85, 85);
        normalizeLon();
        v.lastInteraction = performance.now();
        return;
      }
      if (e.pointerType === "touch") return;
      updateHover(findHit(x, y, 12));
    };

    const endDrag = (e: PointerEvent, allowSelect: boolean) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
      v.lastInteraction = performance.now();
      canvas.style.cursor = "grab";
      if (allowSelect && moved < 6) {
        const [x, y] = localXY(e);
        const hit = findHit(x, y, e.pointerType === "touch" ? 18 : 12);
        if (hit && hit.id !== live.current.activeId) live.current.onSelect(hit.id);
      }
    };

    const onUp = (e: PointerEvent) => endDrag(e, true);
    const onCancel = (e: PointerEvent) => endDrag(e, false);
    const onLeave = () => {
      if (!draggingRef.current) updateHover(null);
    };

    canvas.style.cursor = "grab";
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onLeave);

    const observer = new ResizeObserver(resize);
    observer.observe(stage);
    resize();
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      observer.disconnect();
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      hoverIdRef.current = null;
      draggingRef.current = false;
    };
  }, []);

  const zoomBy = (factor: number) => {
    const v = view.current;
    v.zoomTarget = clamp(v.zoomTarget * factor, 1, 8);
    v.lastInteraction = performance.now();
  };

  const approxCount = points.filter((p) => p.approx).length;

  return (
    <section className="globe-panel" aria-label="Глобус со станциями">
      <div className="globe-head mono">
        <span>
          НА ГЛОБУСЕ — {points.length}
          {total > points.length ? ` ИЗ ${total}` : ""}
        </span>
        {approxCount > 0 && (
          <span className="globe-legend">
            <i className="globe-dot" /> точные · <i className="globe-dot globe-dot-approx" /> по стране
          </span>
        )}
      </div>
      <div className="globe-stage" ref={stageRef}>
        <canvas
          ref={canvasRef}
          aria-label="Интерактивный глобус: перетаскивайте, чтобы вращать, нажмите на точку, чтобы слушать станцию"
        />
        {hover && (
          <div className="globe-tooltip" style={{ left: hover.x, top: hover.y }}>
            <strong>{hover.point.name}</strong>
            {hover.point.subtitle && <span className="mono">{hover.point.subtitle}</span>}
          </div>
        )}
        <div className="globe-controls">
          <button type="button" onClick={() => zoomBy(1.6)} aria-label="Приблизить">
            +
          </button>
          <button type="button" onClick={() => zoomBy(1 / 1.6)} aria-label="Отдалить">
            −
          </button>
        </div>
        <p className="globe-hint mono">Тяните — вращать · клик по точке — слушать</p>
      </div>
    </section>
  );
}
