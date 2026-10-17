"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button, Input, Segmented, Select, Slider, Space, Spin } from "antd";
import { Brush, Eraser, RotateCcw } from "lucide-react";
import type { CanvasImageNode } from "../types";
import { getImageBlob } from "@/features/storage/services/image-storage";
import { CanvasToolDialog } from "./canvas-tool-dialog";
import { canvasImageRefinementGeometry, canvasImageRefinementPreviewWidth, type CanvasImageRefinementMode } from "../domain/canvas-image-refinement";

export type ImageRefinement = { prompt: string; source?: Blob; mask?: Blob; title: string };
const png = (canvas: HTMLCanvasElement) => new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("无法生成 PNG"))), "image/png"));

export function CanvasImageRefine({ node, onCreate, onClose }: { node: CanvasImageNode; onCreate: (edit: ImageRefinement) => Promise<void>; onClose: () => void }) {
    const [mode, setMode] = useState<CanvasImageRefinementMode>("mask"),
        [prompt, setPrompt] = useState("");
    const [brush, setBrush] = useState(40),
        [erase, setErase] = useState(false),
        [padding, setPadding] = useState(25);
    const [azimuth, setAzimuth] = useState(0),
        [elevation, setElevation] = useState(0),
        [light, setLight] = useState("左前方柔光");
    const [ready, setReady] = useState(false),
        [busy, setBusy] = useState(false),
        [error, setError] = useState("");
    const [size, setSize] = useState({ width: 1, height: 1 }),
        [marks, setMarks] = useState(false);
    const base = useRef<HTMLCanvasElement>(null),
        overlay = useRef<HTMLCanvasElement>(null);
    const source = useRef<HTMLImageElement | null>(null),
        drawingPointer = useRef<number | null>(null),
        previous = useRef<{ x: number; y: number } | null>(null);
    const undo = useRef<ImageData[]>([]);
    const busyRef = useRef(false);
    const settingsRef = useRef({ mode, padding });
    settingsRef.current = { mode, padding };
    const imageIdentity = `${node.id}\u0000${node.content.storageKey || ""}\u0000${node.content.source || ""}`;
    const identityRef = useRef(imageIdentity);
    identityRef.current = imageIdentity;
    const loadedIdentity = useRef<string | null>(null);
    const preparedSettings = useRef<{ mode: CanvasImageRefinementMode; padding: number } | null>(null);
    const sourceReady = ready && loadedIdentity.current === imageIdentity && preparedSettings.current?.mode === mode && preparedSettings.current.padding === padding;
    const stopDrawing = useCallback(() => {
        drawingPointer.current = null;
        previous.current = null;
    }, []);
    const prepare = useCallback((image: HTMLImageElement, kind: CanvasImageRefinementMode, margin: number) => {
        const { width, height, sourceWidth, sourceHeight, sourceX, sourceY } = canvasImageRefinementGeometry(image.naturalWidth, image.naturalHeight, kind, margin);
        stopDrawing();
        for (const canvas of [base.current, overlay.current])
            if (canvas) {
                canvas.width = width;
                canvas.height = height;
            }
        base.current?.getContext("2d")?.drawImage(image, sourceX, sourceY, sourceWidth, sourceHeight);
        preparedSettings.current = { mode: kind, padding: margin };
        setSize({ width, height });
        setMarks(false);
        undo.current = [];
    }, [stopDrawing]);
    useEffect(() => {
        let active = true,
            url = "";
        source.current = null;
        loadedIdentity.current = null;
        preparedSettings.current = null;
        stopDrawing();
        undo.current = [];
        setMarks(false);
        setReady(false);
        setError("");
        setSize({ width: 1, height: 1 });
        for (const canvas of [base.current, overlay.current]) {
            if (canvas) {
                canvas.width = 1;
                canvas.height = 1;
            }
        }
        const load = async () => {
            try {
                const blob = node.content.storageKey
                    ? await getImageBlob(node.content.storageKey)
                    : await fetch(node.content.source).then((r) => {
                          if (!r.ok) throw new Error("原图读取失败");
                          return r.blob();
                      });
                if (!active) return;
                if (!blob) throw new Error("原图文件不存在，请重新上传");
                url = URL.createObjectURL(blob);
                const image = new Image();
                image.src = url;
                await image.decode();
                if (!active) return;
                source.current = image;
                const settings = settingsRef.current;
                prepare(image, settings.mode, settings.padding);
                loadedIdentity.current = imageIdentity;
                setReady(true);
            } catch (e) {
                if (active) setError(e instanceof Error ? e.message : "图片加载失败");
            }
        };
        void load();
        return () => {
            active = false;
            stopDrawing();
            if (url) URL.revokeObjectURL(url);
        };
    }, [imageIdentity, node.content.storageKey, node.content.source, prepare, stopDrawing]);
    useEffect(() => {
        if (source.current && !busyRef.current) prepare(source.current, mode, padding);
    }, [mode, padding, prepare]);
    const paint = (event: React.PointerEvent<HTMLCanvasElement>) => {
        if (!sourceReady || busyRef.current || drawingPointer.current !== event.pointerId) return;
        const canvas = event.currentTarget,
            ctx = canvas.getContext("2d");
        if (!ctx) return;
        const bounds = canvas.getBoundingClientRect(),
            point = { x: ((event.clientX - bounds.left) * canvas.width) / bounds.width, y: ((event.clientY - bounds.top) * canvas.height) / bounds.height };
        ctx.globalCompositeOperation = erase ? "destination-out" : "source-over";
        ctx.strokeStyle = "#22d3ee";
        ctx.fillStyle = "#22d3ee";
        ctx.lineWidth = (brush * canvas.width) / Math.max(bounds.width, 1);
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(previous.current?.x ?? point.x, previous.current?.y ?? point.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(point.x, point.y, ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        previous.current = point;
        setMarks(true);
    };
    const create = async () => {
        if (!sourceReady || busyRef.current || !base.current || !overlay.current) return;
        busyRef.current = true;
        stopDrawing();
        setBusy(true);
        setError("");
        const creationIdentity = imageIdentity;
        try {
            // Capture both images before the first await; later loads cannot change this edit.
            const sourceCanvas = document.createElement("canvas");
            sourceCanvas.width = base.current.width;
            sourceCanvas.height = base.current.height;
            sourceCanvas.getContext("2d")!.drawImage(base.current, 0, 0);
            const outputSize = { width: sourceCanvas.width, height: sourceCanvas.height };
            let mask: Blob | undefined;
            let instructions = prompt.trim();
            if (mode === "mask") {
                const pixels = overlay.current.getContext("2d")!.getImageData(0, 0, outputSize.width, outputSize.height).data;
                if (!pixels.some((value, i) => i % 4 === 3 && value > 0)) throw new Error("请先涂抹需要修改的区域");
                if (!instructions) throw new Error("请输入选区内希望修改的内容");
                const canvas = document.createElement("canvas");
                canvas.width = outputSize.width;
                canvas.height = outputSize.height;
                const ctx = canvas.getContext("2d")!;
                ctx.fillStyle = "#000";
                ctx.fillRect(0, 0, outputSize.width, outputSize.height);
                ctx.globalCompositeOperation = "destination-out";
                ctx.drawImage(overlay.current, 0, 0);
                mask = await png(canvas);
                instructions = `只修改蒙版透明区域，保留未选区域的主体身份、构图与细节。${instructions}`;
            } else if (mode === "outpaint") {
                const canvas = document.createElement("canvas");
                canvas.width = outputSize.width;
                canvas.height = outputSize.height;
                const ctx = canvas.getContext("2d")!;
                ctx.drawImage(sourceCanvas, 0, 0);
                ctx.globalCompositeOperation = "source-in";
                ctx.fillStyle = "#000";
                ctx.fillRect(0, 0, outputSize.width, outputSize.height);
                mask = await png(canvas);
                instructions = `把原图四周所有透明区域完整扩展为连续、真实的画面，直到输出图片的上、下、左、右最边缘。保持中央原有主体和画面，延续原图的透视、纹理、色彩与光线。新增区域不能留空、透明或显示蒙版，不能额外添加白边、黑边、画框、模糊边缘或渐隐效果。输出一张边缘完整、不透明的图片。${instructions}`;
            } else if (mode === "light") instructions = `保持参考图主体身份、材质、构图和相机位置，仅将光线调整为${light}。${instructions}`;
            else instructions = `保持参考图中主体的身份、外观、服装与材质，调整拍摄视角：相对原图水平环绕 ${azimuth} 度、垂直俯仰 ${elevation} 度。正值为向右环绕与俯拍，负值为向左环绕与仰拍。${instructions}`;
            await onCreate({ prompt: instructions, source: await png(sourceCanvas), mask, title: mode === "mask" ? "局部精修" : mode === "outpaint" ? "扩图" : mode === "light" ? "打光调整" : "视角调整" });
            if (identityRef.current === creationIdentity) onClose();
        } catch (e) {
            if (identityRef.current === creationIdentity) setError(e instanceof Error ? e.message : "创建编辑节点失败");
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    };
    return (
        <CanvasToolDialog
            title="图片精修"
            subtitle="保留原图，编辑内容和参考素材保存为新的画布节点。"
            icon={<Brush />}
            width={980}
            onClose={() => {
                if (!busyRef.current) onClose();
            }}
        >
            <div className="space-y-4 p-5">
                <Segmented
                    block
                    value={mode}
                    disabled={busy}
                    onChange={(value) => setMode(value as CanvasImageRefinementMode)}
                    options={[
                        { value: "mask", label: "局部重绘" },
                        { value: "outpaint", label: "扩图" },
                        { value: "light", label: "打光" },
                        { value: "angle", label: "视角" },
                    ]}
                />
                {error && (
                    <p role="alert" className="text-sm text-red-500">
                        {error}
                    </p>
                )}
                <div className="grid gap-5 md:grid-cols-[minmax(0,1.6fr)_minmax(230px,1fr)]">
                    <div className="flex min-h-64 items-center justify-center rounded-2xl bg-black/10 p-3">
                        {!sourceReady && !error && <Spin />}
                        <div className="relative w-full" style={{ maxWidth: canvasImageRefinementPreviewWidth(size.width, size.height), aspectRatio: `${size.width}/${size.height}`, visibility: sourceReady ? "visible" : "hidden" }}>
                            <canvas ref={base} className="block h-auto w-full rounded-lg" style={{ background: "repeating-conic-gradient(#aaa2 0% 25%, transparent 0% 50%) 50% / 16px 16px" }} />
                            <canvas
                                ref={overlay}
                                className="absolute inset-0 h-full w-full touch-none rounded-lg opacity-50"
                                style={{ pointerEvents: mode === "mask" && sourceReady && !busy ? "auto" : "none", cursor: "crosshair" }}
                                onPointerDown={(event) => {
                                    if (!sourceReady || busyRef.current || drawingPointer.current !== null || event.button !== 0) return;
                                    event.currentTarget.setPointerCapture(event.pointerId);
                                    const ctx = event.currentTarget.getContext("2d")!;
                                    undo.current = [...undo.current.slice(-7), ctx.getImageData(0, 0, size.width, size.height)];
                                    drawingPointer.current = event.pointerId;
                                    previous.current = null;
                                    paint(event);
                                }}
                                onPointerMove={(event) => {
                                    if (drawingPointer.current === event.pointerId) paint(event);
                                }}
                                onPointerUp={(event) => { if (drawingPointer.current === event.pointerId) stopDrawing(); }}
                                onPointerCancel={(event) => { if (drawingPointer.current === event.pointerId) stopDrawing(); }}
                                onLostPointerCapture={(event) => { if (drawingPointer.current === event.pointerId) stopDrawing(); }}
                            />
                        </div>
                    </div>
                    <div className="space-y-4 text-sm">
                        {mode === "mask" && (
                            <>
                                <p className="text-xs opacity-65">涂抹要修改的区域；青色表示选区。生成时透明蒙版会和原图一起提交。</p>
                                <label>
                                    笔刷大小
                                    <Slider disabled={busy} min={4} max={120} value={brush} onChange={setBrush} />
                                </label>
                                <Space wrap>
                                    <Button disabled={busy || !sourceReady} icon={erase ? <Brush size={14} /> : <Eraser size={14} />} onClick={() => { stopDrawing(); setErase(!erase); }}>
                                        {erase ? "改为涂抹" : "擦除选区"}
                                    </Button>
                                    <Button
                                        icon={<RotateCcw size={14} />}
                                        disabled={busy || !sourceReady || !marks}
                                        onClick={() => {
                                            stopDrawing();
                                            const last = undo.current.pop();
                                            if (last) overlay.current?.getContext("2d")?.putImageData(last, 0, 0);
                                            setMarks(undo.current.length > 0);
                                        }}
                                    >
                                        撤销笔画
                                    </Button>
                                    <Button
                                        disabled={busy || !sourceReady}
                                        onClick={() => {
                                            stopDrawing();
                                            overlay.current?.getContext("2d")?.clearRect(0, 0, size.width, size.height);
                                            undo.current = [];
                                            setMarks(false);
                                        }}
                                    >
                                        清空
                                    </Button>
                                </Space>
                            </>
                        )}
                        {mode === "outpaint" && (
                            <label>
                                每边扩展 {padding}%<Slider disabled={busy} min={10} max={60} step={5} value={padding} onChange={setPadding} />
                            </label>
                        )}
                        {mode === "light" && (
                            <label>
                                灯光方向
                                <Select disabled={busy} className="mt-2 w-full" value={light} onChange={setLight} options={["左前方柔光", "右侧硬光", "正面柔和补光", "逆光轮廓光", "顶部电影光", "暖色日落侧光"].map((value) => ({ value, label: value }))} />
                            </label>
                        )}
                        {mode === "angle" && (
                            <>
                                <label>
                                    水平环绕 {azimuth}°<Slider disabled={busy} min={-180} max={180} step={15} value={azimuth} onChange={setAzimuth} />
                                </label>
                                <label>
                                    俯仰角度 {elevation}°<Slider disabled={busy} min={-60} max={60} step={15} value={elevation} onChange={setElevation} />
                                </label>
                            </>
                        )}
                        <Input.TextArea disabled={busy} aria-label="图片精修要求" placeholder={mode === "mask" ? "例如：移除路人并补全背景" : "补充创作要求（可选）"} rows={4} maxLength={3000} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                        <p className="text-xs opacity-60">{maskMode(mode) ? "局部重绘与扩图需要模型支持 OpenAI images/edits 蒙版。" : "打光和视角调整通过图生图实现。"} 创建节点后可检查参数，再点击生成。预处理长边最多 2048 像素。</p>
                        <Button block type="primary" loading={busy} disabled={!sourceReady || busy} onClick={() => void create()}>
                            创建编辑节点
                        </Button>
                    </div>
                </div>
            </div>
        </CanvasToolDialog>
    );
}
const maskMode = (mode: string) => mode === "mask" || mode === "outpaint";
