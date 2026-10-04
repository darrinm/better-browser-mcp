// GIF export for gif_creator: draws action overlays onto recorded frames
// with OffscreenCanvas and encodes them with gifenc. Runs in the service
// worker (OffscreenCanvas and createImageBitmap are available there).

import { GIFEncoder, quantize, applyPalette } from "./vendor/gifenc.esm.js";

const ORANGE = "#d97757";
const MAX_WIDTH = 800;

export function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export async function decodeImage(base64, mime = "image/jpeg") {
  return createImageBitmap(new Blob([base64ToBytes(base64)], { type: mime }));
}

// frames: [{ base64, mime, frameWidth, frameHeight, action?: { type, label,
// coordinate?: [x, y], start?: [x, y] } }], where coordinates are in the
// frameWidth x frameHeight (CSS viewport) space.
export async function encodeGif(frames, options = {}) {
  if (!frames.length) throw new Error("No frames recorded. Start recording, take actions, then export.");
  const o = {
    showClickIndicators: true,
    showDragPaths: true,
    showActionLabels: true,
    showProgressBar: true,
    showWatermark: true,
    quality: 10,
    ...options,
  };
  // gifenc quantizes per frame; map the 1-30 quality knob (lower = better)
  // onto palette size.
  const maxColors = o.quality <= 10 ? 256 : o.quality <= 20 ? 128 : 64;

  const bitmaps = await Promise.all(frames.map((f) => decodeImage(f.base64, f.mime)));
  const width = Math.min(MAX_WIDTH, bitmaps[0].width);
  const height = Math.round((bitmaps[0].height * width) / bitmaps[0].width);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const gif = GIFEncoder();

  frames.forEach((frame, i) => {
    ctx.drawImage(bitmaps[i], 0, 0, width, height);
    const sx = width / (frame.frameWidth || bitmaps[i].width);
    const sy = height / (frame.frameHeight || bitmaps[i].height);
    const pt = (p) => [p[0] * sx, p[1] * sy];
    const a = frame.action;

    if (a && o.showDragPaths && a.start && a.coordinate) drawArrow(ctx, pt(a.start), pt(a.coordinate));
    if (a && o.showClickIndicators && a.coordinate && /click|drag/.test(a.type)) drawClick(ctx, pt(a.coordinate));
    if (a && o.showActionLabels && a.label) drawLabel(ctx, a.label, width);
    if (o.showProgressBar) {
      ctx.fillStyle = ORANGE;
      ctx.fillRect(0, height - 4, (width * (i + 1)) / frames.length, 4);
    }
    if (o.showWatermark) drawWatermark(ctx, width, height);

    const { data } = ctx.getImageData(0, 0, width, height);
    const palette = quantize(data, maxColors);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, { palette, delay: i === frames.length - 1 ? 2000 : 1000 });
  });
  gif.finish();
  return bytesToBase64(gif.bytes());
}

function drawClick(ctx, [x, y]) {
  ctx.save();
  ctx.lineWidth = 3;
  ctx.strokeStyle = ORANGE;
  ctx.fillStyle = "rgba(217,119,87,0.25)";
  ctx.beginPath();
  ctx.arc(x, y, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawArrow(ctx, [x0, y0], [x1, y1]) {
  ctx.save();
  ctx.strokeStyle = "#e0312b";
  ctx.fillStyle = "#e0312b";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  const ang = Math.atan2(y1 - y0, x1 - x0);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x1 - 12 * Math.cos(ang - 0.4), y1 - 12 * Math.sin(ang - 0.4));
  ctx.lineTo(x1 - 12 * Math.cos(ang + 0.4), y1 - 12 * Math.sin(ang + 0.4));
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawLabel(ctx, text, width) {
  ctx.save();
  ctx.font = "600 14px sans-serif";
  let label = text;
  while (ctx.measureText(label).width > width - 40 && label.length > 4) label = label.slice(0, -2);
  if (label !== text) label = label.slice(0, -1) + "…";
  const w = ctx.measureText(label).width + 20;
  ctx.fillStyle = "rgba(0,0,0,0.78)";
  roundRect(ctx, 10, 10, w, 28, 6);
  ctx.fill();
  ctx.fillStyle = "#fff";
  ctx.textBaseline = "middle";
  ctx.fillText(label, 20, 24);
  ctx.restore();
}

function drawWatermark(ctx, width, height) {
  const s = 22;
  const x = width - s - 10;
  const y = height - s - 12;
  ctx.save();
  ctx.globalAlpha = 0.85;
  ctx.fillStyle = ORANGE;
  roundRect(ctx, x, y, s, s, 5);
  ctx.fill();
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(x + s * 0.3, y + s * 0.28);
  ctx.lineTo(x + s * 0.62, y + s * 0.5);
  ctx.lineTo(x + s * 0.3, y + s * 0.72);
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Re-encode an image (e.g. a JPEG screenshot) as PNG.
export async function toPng(base64, mime) {
  const bmp = await decodeImage(base64, mime);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}
