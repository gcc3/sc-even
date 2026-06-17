// Copies Silero VAD model and ONNX runtime WASM files into public/ so the dev
// server and production build can serve them at the site root.
//
// onnxruntime-web 1.17.x ships four WASM variants and selects at runtime:
//   ort-wasm-simd.wasm          SIMD, no threads (used on devices without SharedArrayBuffer)
//   ort-wasm-simd-threaded.wasm SIMD + threads   (used when SharedArrayBuffer is available)
//   ort-wasm.wasm               basic fallback    (no SIMD, no threads)
//   ort-wasm-threaded.wasm      threads, no SIMD  (rare; included for completeness)
//
// The glasses run WebKit without COOP/COEP headers, so SharedArrayBuffer is
// unavailable there and ort selects ort-wasm-simd.wasm. The dev server adds
// COOP/COEP (see vite.config.ts) so ort uses ort-wasm-simd-threaded.wasm.
const { copyFileSync, mkdirSync, existsSync, rmSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const nm = join(root, "node_modules");
const dest = join(root, "public");

if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

const files = [
  [join(nm, "@ricky0123/vad-web/dist/silero_vad_v5.onnx"), "silero_vad_v5.onnx"],
  [join(nm, "onnxruntime-web/dist/ort-wasm-simd.wasm"), "ort-wasm-simd.wasm"],
  [join(nm, "onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"), "ort-wasm-simd-threaded.wasm"],
  [join(nm, "onnxruntime-web/dist/ort-wasm.wasm"), "ort-wasm.wasm"],
];

for (const [src, filename] of files) {
  copyFileSync(src, join(dest, filename));
  console.log(`Copied ${filename}`);
}

// Remove stale files left over from onnxruntime-web 1.26.x which shipped .mjs
// glue scripts and asyncify variants that are no longer needed.
const stale = [
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.asyncify.mjs",
];
for (const filename of stale) {
  const p = join(dest, filename);
  if (existsSync(p)) {
    rmSync(p);
    console.log(`Removed stale ${filename}`);
  }
}
