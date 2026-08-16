"use client";

import { useEffect, useImperativeHandle, useRef, useState, type RefObject } from "react";

/**
 * マスク描画。塗った範囲＝作り直したい範囲。
 *
 * ★ 塗りは常に不透明（alpha = 255）で描き、見た目だけ CSS の opacity で薄くしている。
 *   半透明で描くと、重ね塗りのたびに alpha が増えて「どこまで塗ったか」が
 *   ストロークの重なりに依存してしまう。サーバー側は alpha を閾値で 2 値化するので、
 *   境界が塗り方次第で動くことになる。
 */

export type MaskCanvasHandle = {
  /** 塗った内容を PNG（塗った部分だけ不透明）として取り出す。未使用なら null。 */
  toBlob: () => Promise<Blob | null>;
  clear: () => void;
  hasPaint: () => boolean;
};

/** canvas の内部解像度の長辺。表示サイズとは無関係。 */
const CANVAS_LONG_EDGE = 1024;

export function MaskCanvas({
  imageUrl,
  handleRef,
}: {
  imageUrl: string;
  handleRef: RefObject<MaskCanvasHandle | null>;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const drawing = useRef(false);
  const painted = useRef(false);
  const [brush, setBrush] = useState(40);
  const [erasing, setErasing] = useState(false);
  const [ready, setReady] = useState(false);

  // 画像が変わったら canvas を作り直す（前の写真の塗りが残らないように）。
  useEffect(() => {
    const image = imgRef.current;
    const canvas = canvasRef.current;
    if (!image || !canvas) return;

    function fit() {
      const img = imgRef.current;
      const cv = canvasRef.current;
      if (!img || !cv || !img.naturalWidth) return;
      const scale = CANVAS_LONG_EDGE / Math.max(img.naturalWidth, img.naturalHeight);
      cv.width = Math.max(1, Math.round(img.naturalWidth * Math.min(1, scale)));
      cv.height = Math.max(1, Math.round(img.naturalHeight * Math.min(1, scale)));
      painted.current = false;
      setReady(true);
    }

    if (image.complete) fit();
    else image.addEventListener("load", fit, { once: true });
    return () => image.removeEventListener("load", fit);
  }, [imageUrl]);

  useImperativeHandle(handleRef, () => ({
    toBlob: () =>
      new Promise<Blob | null>((resolve) => {
        const canvas = canvasRef.current;
        if (!canvas || !painted.current) return resolve(null);
        canvas.toBlob((blob) => resolve(blob), "image/png");
      }),
    clear: () => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      painted.current = false;
    },
    hasPaint: () => painted.current,
  }));

  /** 画面上の座標を canvas の内部座標へ写す。 */
  function toCanvasPoint(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  }

  function begin(event: React.PointerEvent<HTMLCanvasElement>) {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    canvas.setPointerCapture(event.pointerId);
    drawing.current = true;

    const { x, y } = toCanvasPoint(event);
    // 表示サイズと内部解像度の比でブラシ径を合わせる
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    ctx.globalCompositeOperation = erasing ? "destination-out" : "source-over";
    ctx.strokeStyle = "rgba(255, 40, 40, 1)";
    ctx.fillStyle = "rgba(255, 40, 40, 1)";
    ctx.lineWidth = brush * ratio;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(x, y);
    // 点を打っただけでも塗れるようにする
    ctx.arc(x, y, (brush * ratio) / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.moveTo(x, y);
    if (!erasing) painted.current = true;
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    const { x, y } = toCanvasPoint(event);
    ctx.lineTo(x, y);
    ctx.stroke();
  }

  function end() {
    drawing.current = false;
    const ctx = canvasRef.current?.getContext("2d");
    ctx?.closePath();
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        <button type="button" aria-pressed={!erasing} onClick={() => setErasing(false)}>
          ブラシ
        </button>
        <button type="button" aria-pressed={erasing} onClick={() => setErasing(true)}>
          消しゴム
        </button>
        <label style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span className="muted">太さ</span>
          <input
            type="range"
            min={8}
            max={120}
            value={brush}
            onChange={(e) => setBrush(Number(e.target.value))}
          />
        </label>
        <button type="button" onClick={() => handleRef.current?.clear()}>
          全部消す
        </button>
      </div>

      <div style={{ position: "relative", lineHeight: 0 }}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={imageUrl}
          alt="アップロードした写真"
          className="preview"
          style={{ touchAction: "none" }}
        />
        <canvas
          ref={canvasRef}
          onPointerDown={begin}
          onPointerMove={move}
          onPointerUp={end}
          onPointerLeave={end}
          style={{
            position: "absolute",
            inset: 0,
            width: "100%",
            height: "100%",
            opacity: 0.5,
            cursor: "crosshair",
            touchAction: "none",
            borderRadius: 8,
          }}
        />
      </div>

      <p className="muted" style={{ marginTop: 6 }}>
        {ready
          ? "消したい部分を赤く塗ってください。塗った範囲だけが作り直されます。"
          : "写真を読み込んでいます…"}
      </p>
    </div>
  );
}
