// Copies Silero VAD model and ONNX runtime WASM files into public/ so the dev
// server and production build can serve them at the site root.
const { copyFileSync, mkdirSync, existsSync } = require("fs");
const { join } = require("path");

const root = join(__dirname, "..");
const nm = join(root, "node_modules");
const dest = join(root, "public");

if (!existsSync(dest)) mkdirSync(dest, { recursive: true });

const files = [
  [join(nm, "@ricky0123/vad-web/dist/silero_vad_v5.onnx"), "silero_vad_v5.onnx"],
  [join(nm, "onnxruntime-web/dist/ort-wasm-simd-threaded.wasm"), "ort-wasm-simd-threaded.wasm"],
  [join(nm, "onnxruntime-web/dist/ort-wasm-simd-threaded.mjs"), "ort-wasm-simd-threaded.mjs"],
  [join(nm, "onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.wasm"), "ort-wasm-simd-threaded.asyncify.wasm"],
  [join(nm, "onnxruntime-web/dist/ort-wasm-simd-threaded.asyncify.mjs"), "ort-wasm-simd-threaded.asyncify.mjs"],
];

for (const [src, filename] of files) {
  copyFileSync(src, join(dest, filename));
  console.log(`Copied ${filename}`);
}
