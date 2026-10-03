import { BlurFilter, GlProgram, GpuProgram } from "pixi.js";

// Match Pixi's five-tap Gaussian kernel. Clamp each sample in the fragment
// shader so interpolation cannot pull transparent pooled-texture padding in.
const fragment = `
in vec2 vBlurTexCoords[5];
uniform sampler2D uTexture;
uniform vec4 uInputClamp;
out vec4 finalColor;

void main(void) {
  finalColor =
    texture(uTexture, clamp(vBlurTexCoords[0], uInputClamp.xy, uInputClamp.zw)) * 0.153388
    + texture(uTexture, clamp(vBlurTexCoords[1], uInputClamp.xy, uInputClamp.zw)) * 0.221461
    + texture(uTexture, clamp(vBlurTexCoords[2], uInputClamp.xy, uInputClamp.zw)) * 0.250301
    + texture(uTexture, clamp(vBlurTexCoords[3], uInputClamp.xy, uInputClamp.zw)) * 0.221461
    + texture(uTexture, clamp(vBlurTexCoords[4], uInputClamp.xy, uInputClamp.zw)) * 0.153388;
}
`;

const gpuFragment = `
struct GlobalFilterUniforms {
  uInputSize: vec4<f32>,
  uInputPixel: vec4<f32>,
  uInputClamp: vec4<f32>,
  uOutputFrame: vec4<f32>,
  uGlobalFrame: vec4<f32>,
  uOutputTexture: vec4<f32>,
};

@group(0) @binding(0) var<uniform> gfu: GlobalFilterUniforms;
@group(0) @binding(1) var uTexture: texture_2d<f32>;
@group(0) @binding(2) var uSampler: sampler;

@fragment
fn mainFragment(
  @location(0) offset0: vec2<f32>,
  @location(1) offset1: vec2<f32>,
  @location(2) offset2: vec2<f32>,
  @location(3) offset3: vec2<f32>,
  @location(4) offset4: vec2<f32>,
) -> @location(0) vec4<f32> {
  return
    textureSample(uTexture, uSampler, clamp(offset0, gfu.uInputClamp.xy, gfu.uInputClamp.zw)) * 0.153388
    + textureSample(uTexture, uSampler, clamp(offset1, gfu.uInputClamp.xy, gfu.uInputClamp.zw)) * 0.221461
    + textureSample(uTexture, uSampler, clamp(offset2, gfu.uInputClamp.xy, gfu.uInputClamp.zw)) * 0.250301
    + textureSample(uTexture, uSampler, clamp(offset3, gfu.uInputClamp.xy, gfu.uInputClamp.zw)) * 0.221461
    + textureSample(uTexture, uSampler, clamp(offset4, gfu.uInputClamp.xy, gfu.uInputClamp.zw)) * 0.153388;
}
`;

/** Gaussian privacy blur with an exact rectangle and no artificial edge fade. */
export function createPrivacyBlurFilter(strength: number): BlurFilter {
  const filter = new BlurFilter({ strength, kernelSize: 5 });
  filter.repeatEdgePixels = true;

  // Keep Pixi's axis offsets, strength, quality and multi-pass implementation.
  // Only sampling changes; original image alpha continues through the kernel.
  for (const pass of [filter.blurXFilter, filter.blurYFilter]) {
    pass.glProgram = GlProgram.from({
      vertex: pass.glProgram.vertex!,
      fragment,
      name: "privacy-blur-pass",
    });
    pass.gpuProgram = GpuProgram.from({
      vertex: pass.gpuProgram.vertex!,
      fragment: { source: gpuFragment, entryPoint: "mainFragment" },
      name: "privacy-blur-pass",
    });
  }

  return filter;
}
