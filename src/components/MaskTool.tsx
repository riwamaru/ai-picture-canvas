"use client";

import { useCallback, useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";

/**
 * F-15 マスク描画 UI。確定 UI（index.html）の .mask-tool をそのまま移植した。
 *
 * モックからの実装上の変更は 2 点だけ：
 *
 *  ① モックは canvas の内部解像度を「表示サイズ」にしていた。
 *     ウィンドウ幅で塗った内容の解像度が変わり、送信するマスクの精度が
 *     見ている画面によって変わってしまう。元画像の長辺基準に固定した。
 *
 *  ② モックは半透明（alpha 0.55）で塗っていた。見た目はそのままだが、
 *     内部では不透明で保持する。半透明のままだと重ね塗りのたびに alpha が増え、
 *     サーバー側の 2 値化の境界が「何回なぞったか」で動いてしまう。
 *     見た目の薄さは CSS の opacity で出す。
 */

export type MaskHandle = {
  toBlob: () => Promise<Blob | null>;
  clear: () => void;
  hasPaint: () => boolean;
};

/** canvas の内部解像度の長辺。 */
const CANVAS_LONG_EDGE = 1024;

type Stroke = { size: number; points: { x: number; y: number }[] };

export function MaskTool({
  imageUrl,
  handleRef,
  onStrokesChange,
}: {
  imageUrl: string | null;
  handleRef: RefObject<MaskHandle | null>;
  onStrokesChange: (count: number) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const strokes = useRef<Stroke[]>([]);
  const current = useRef<Stroke | null>(null);
  const drawing = useRef(false);
  const [brushSize, setBrushSize] = useState(26);
  const brushRef = useRef(26);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const paint = (stroke: Stroke) => {
      // 内部は不透明で塗る（薄さは CSS の opacity で出す）
      ctx.strokeStyle = "rgb(245, 158, 11)";
      ctx.fillStyle = "rgb(245, 158, 11)";
      ctx.lineWidth = stroke.size;
      ctx.lineJoin = ctx.lineCap = "round";
      const pts = stroke.points;
      if (pts.length === 1) {
        ctx.beginPath();
        ctx.arc(pts[0]!.x, pts[0]!.y, stroke.size / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
      }
      ctx.beginPath();
      ctx.moveTo(pts[0]!.x, pts[0]!.y);
      for (let i = 1; i < pts.length; i += 1) ctx.lineTo(pts[i]!.x, pts[i]!.y);
      ctx.stroke();
    };

    strokes.current.forEach(paint);
    if (current.current) paint(current.current);
  }, []);

  // 画像が変わったら canvas を作り直す（前の写真の塗りを残さない）
  useEffect(() => {
    if (!imageUrl) return;
    const image = imgRef.current;
    if (!image) return;

    const fit = () => {
      const canvas = canvasRef.current;
      if (!canvas || !image.naturalWidth) return;
      const scale = Math.min(1, CANVAS_LONG_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      strokes.current = [];
      current.current = null;
      onStrokesChange(0);
      redraw();
    };

    if (image.complete) fit();
    else image.addEventListener("load", fit, { once: true });
    return () => image.removeEventListener("load", fit);
  }, [imageUrl, redraw, onStrokesChange]);

  useImperativeHandle(handleRef, () => ({
    toBlob: () =>
      new Promise<Blob | null>((resolve) => {
        const canvas = canvasRef.current;
        if (!canvas || strokes.current.length === 0) return resolve(null);
        canvas.toBlob((blob) => resolve(blob), "image/png");
      }),
    clear: () => {
      strokes.current = [];
      current.current = null;
      onStrokesChange(0);
      redraw();
    },
    hasPaint: () => strokes.current.length > 0,
  }));

  function toPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function begin(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    if (!canvas) return;
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    drawing.current = true;
    // 表示サイズと内部解像度の比でブラシ径を合わせる
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    current.current = { size: brushRef.current * ratio, points: [toPoint(event)] };
    redraw();
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || !current.current) return;
    event.preventDefault();
    current.current.points.push(toPoint(event));
    redraw();
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    if (current.current && current.current.points.length > 0) {
      strokes.current.push(current.current);
      onStrokesChange(strokes.current.length);
    }
    current.current = null;
    redraw();
  }

  function undo() {
    strokes.current.pop();
    onStrokesChange(strokes.current.length);
    redraw();
  }

  return (
    <div className="mask-tool">
      {!imageUrl && (
        <div className="mask-empty" id="mask-empty" style={{ display: "flex" }}>
          <i className="fa-solid fa-image" />
          先に「STEP 1」で元画像をアップロードしてください。
          <br />
          アップロード後、ここに除去範囲を塗るマスク描画キャンバスが表示されます。
        </div>
      )}

      <div className={`mask-workspace${imageUrl ? " show" : ""}`} id="mask-workspace">
        <div className="mask-canvas-wrap" id="mask-canvas-wrap">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img id="mask-bg-img" ref={imgRef} src={imageUrl ?? ""} alt="マスク対象" />
          <canvas
            id="mask-canvas"
            ref={canvasRef}
            onPointerDown={begin}
            onPointerMove={move}
            onPointerUp={end}
            onPointerCancel={end}
            style={{ opacity: 0.55, touchAction: "none" }}
          />
          <span className="mask-hint">
            <i className="fa-solid fa-paintbrush" /> ドラッグして除去範囲を塗る
          </span>
        </div>

        <div className="mask-controls">
          <div className="mask-brush-control">
            <i className="fa-solid fa-paintbrush" style={{ color: "var(--type-c)" }} /> ブラシサイズ
            <input
              type="range"
              id="brush-size"
              min={6}
              max={60}
              value={brushSize}
              onChange={(e) => {
                const value = Number(e.target.value);
                setBrushSize(value);
                brushRef.current = value;
              }}
            />
            <span className="mask-brush-size" id="brush-size-val">
              {brushSize}px
            </span>
          </div>
          <button type="button" className="mask-btn" onClick={undo}>
            <i className="fa-solid fa-rotate-left" /> 取り消し
          </button>
          <button
            type="button"
            className="mask-btn"
            onClick={() => {
              strokes.current = [];
              onStrokesChange(0);
              redraw();
            }}
          >
            <i className="fa-solid fa-trash-can" /> 全消去
          </button>
        </div>
      </div>
    </div>
  );
}
