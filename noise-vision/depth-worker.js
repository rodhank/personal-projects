// Depth worker: Depth Anything V2 small, in the browser.
// Tries WebGPU fp16 first (fast on iOS 26 / desktop), falls back to WASM q8 (~27 MB, works everywhere).
// Main thread sends frames (newest wins); we answer with the raw predicted_depth
// (relative inverse depth: bigger = closer) plus timing, so latency is measured on the device itself.
const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.2';
const MODEL = 'onnx-community/depth-anything-v2-small';
let lib, pipe, info = null;

async function build(device, dtype){
  const p = await lib.pipeline('depth-estimation', MODEL, { device, dtype,
    progress_callback: (e) => { if (e.status === 'progress' && e.total) self.postMessage({ type: 'progress', loaded: e.loaded, total: e.total, file: e.file }); } });
  return p;
}

async function load(prefer){
  lib ??= await import(CDN);
  lib.env.allowLocalModels = false;
  try { lib.env.backends.onnx.wasm.numThreads = 1; } catch (e) {}
  const tries = [];
  if (prefer !== 'wasm' && self.navigator && navigator.gpu) tries.push(['webgpu', 'fp16'], ['webgpu', 'fp32']);
  tries.push(['wasm', 'q8']);
  let err;
  for (const [device, dtype] of tries){
    try {
      pipe = await build(device, dtype);
      // smoke test: some GPUs build the session but fail on the first run
      const pr = pipe.processor && pipe.processor.image_processor;
      if (pr){ pr.size = { width: 56, height: 56 }; pr.keep_aspect_ratio = false; }
      await pipe(new lib.RawImage(new Uint8ClampedArray(56 * 56 * 4).fill(128), 56, 56, 4));
      info = { device, dtype };
      return;
    } catch (e){ err = e; pipe = null; }
  }
  throw err || new Error('no backend');
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load'){
      await load(data.prefer);
      self.postMessage({ type: 'ready', ...info });
    } else if (data.type === 'infer'){
      const proc = pipe.processor && pipe.processor.image_processor;
      if (proc){ proc.size = { width: data.iw, height: data.ih }; proc.keep_aspect_ratio = false; proc.ensure_multiple_of = 14; }
      const img = new lib.RawImage(new Uint8ClampedArray(data.pixels), data.w, data.h, 4);
      const t0 = performance.now();
      const out = await pipe(img);
      const ms = performance.now() - t0;
      const t = out.predicted_depth;
      const [h, w] = t.dims.slice(-2);
      const px = Float32Array.from(t.data);
      self.postMessage({ type: 'depth', id: data.id, w, h, ms, pixels: px }, [px.buffer]);
    }
  } catch (e){
    self.postMessage({ type: 'error', id: data.id, phase: data.type, message: String(e && e.message || e) });
  }
};
