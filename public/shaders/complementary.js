/**
 * Complementary Shaders - Reimagined look-alike, implemented as a self-contained GLSL pipeline
 * for the Aperture renderer. This is NOT an Iris/OptiFine shaderpack loader -- the project cannot
 * consume real shaderpacks (see README section 8); this module reproduces the *look* with bespoke
 * GLSL that runs inside this renderer's own post-processing chain.
 *
 * Everything here is additive: app.js keeps the legacy sky/water/final materials untouched, so
 * cinematic / realistic / vanilla / performance render bit-identically to before. The new materials
 * are only swapped in for the `complementary_reimagined` preset (shaderState.cs === 1).
 */

/** Defaults for the CS-only parameters. Legacy presets keep `cs: 0`, which disables every CS material. */
export const CS_DEFAULTS = {
  cs: 0,
  // --- sky / atmosphere ---
  clouds: 1,
  cloudCoverage: 0.5,
  cloudDensity: 1.0,
  cloudSpeed: 0.35,
  cloudHeight: 120,
  cloudScale: 1.0,
  sunWarmth: 0.6,
  skyIntensity: 1.0,
  atmosphere: 1.0,
  // --- water ---
  waterWaves: 1.0,
  waterFresnel: 1.0,
  waterReflection: 1.0,
  waterWaveHeight: 0.55,
  waterFoam: 1.0,
  // --- post ---
  bloomThreshold: 0.72,
  bloomKnee: 0.4,
  bloomRadius: 2.0,
  bloomIterations: 1,
  autoExposure: 0.0,
  ssao: 0,
  ssaoStrength: 0.85,
  ssaoRadius: 1.5,
  heightFog: 0.0,
  heightFogFalloff: 20,
  fogBase: -64,
  raysDensity: 0.95,
  raysDecay: 0.955,
  toneMapping: 'aces',
  contrast: 1.0,
  temperature: 0.0,
  splitWarm: 0.0,
  splitCool: 0.0,
  sharpen: 0.0,
};

/** The complementary_reimagined preset. Legacy keys stay in the same units/meaning as the old presets. */
export const CS_PRESET = {
  // legacy pipeline keys (kept so the shared passes still work)
  exposure: 1.05,
  shadows: true,
  shadowSize: 2048,
  bloom: true,
  bloomStrength: 0.7,
  rays: true,
  rayStrength: 0.6,
  fog: 0.0016,
  saturation: 1.06,
  vignette: 0.3,
  // CS pipeline
  cs: 1,
  clouds: 1,
  cloudCoverage: 0.5,
  cloudDensity: 1.0,
  cloudSpeed: 0.35,
  cloudHeight: 120,
  cloudScale: 1.0,
  sunWarmth: 0.65,
  skyIntensity: 1.05,
  atmosphere: 1.0,
  waterWaves: 1.0,
  waterFresnel: 1.0,
  waterReflection: 1.0,
  waterWaveHeight: 0.55,
  waterFoam: 1.0,
  bloomThreshold: 0.68,
  bloomKnee: 0.35,
  bloomRadius: 2.1,
  bloomIterations: 2,
  autoExposure: 0.6,
  ssao: 1,
  ssaoStrength: 0.9,
  ssaoRadius: 1.6,
  heightFog: 0.012,
  heightFogFalloff: 18,
  fogBase: -64,
  raysDensity: 0.95,
  raysDecay: 0.96,
  toneMapping: 'aces',
  contrast: 1.05,
  temperature: 0.05,
  splitWarm: 0.05,
  splitCool: 0.07,
  sharpen: 0.45,
};

/** CS-style parameter names that map onto legacy shaderState keys. */
export const CS_PARAM_ALIASES = {
  shadowMapResolution: 'shadowSize',
  fogDensity: 'fog',
  rayStrength: 'rayStrength',
};

export const TONE_MAPPINGS = ['aces', 'filmic', 'neutral'];

/** Numeric parameters and their documented ranges (used by the override sanitizer + docs). */
export const CS_PARAM_RANGES = {
  cs: [0, 1],
  exposure: [0.05, 4],
  shadowSize: [256, 8192],
  bloomStrength: [0, 4],
  rayStrength: [0, 4],
  fog: [0, 0.05],
  saturation: [0, 3],
  vignette: [0, 2],
  clouds: [0, 1],
  cloudCoverage: [0.02, 0.98],
  cloudDensity: [0, 3],
  cloudSpeed: [0, 20],
  cloudHeight: [-200, 2000],
  cloudScale: [0.05, 20],
  sunWarmth: [0, 2],
  skyIntensity: [0, 4],
  atmosphere: [0, 4],
  waterWaves: [0, 4],
  waterFresnel: [0, 2],
  waterReflection: [0, 2],
  waterWaveHeight: [0, 3],
  waterFoam: [0, 2],
  bloomThreshold: [0, 4],
  bloomKnee: [0.001, 2],
  bloomRadius: [0.2, 12],
  bloomIterations: [1, 2],
  autoExposure: [0, 2],
  ssaoStrength: [0, 2],
  ssaoRadius: [0.1, 12],
  heightFog: [0, 0.2],
  heightFogFalloff: [1, 500],
  fogBase: [-512, 512],
  raysDensity: [0.1, 2],
  raysDecay: [0.5, 1],
  contrast: [0.5, 2],
  temperature: [-1, 1],
  splitWarm: [0, 1],
  splitCool: [0, 1],
  sharpen: [0, 2],
};

/** Parameters that are reset to defaults when a preset is applied (legacy behaviour preserved). */
export const LEGACY_PARAM_DEFAULTS = {
  exposure: 1.08,
  shadows: true,
  shadowSize: 2048,
  bloom: true,
  bloomStrength: 0.32,
  rays: true,
  rayStrength: 0.55,
  fog: 0.00135,
  saturation: 1.04,
  vignette: 0.28,
};

/* -------------------------------------------------------------------------------------------------
 * Sky: gradient + warm sunrise/sunset + sun disk + moon + stars + pseudo-volumetric clouds.
 * The cloud layer ray-marches a virtual cloud deck (analytic plane hit) and fakes self-shadowing by
 * sampling the density field a few steps toward the sun. It is cheap (no 3D volume texture) and
 * deterministic: cloud drift is frozen while taking screenshots.
 * ------------------------------------------------------------------------------------------------ */
export const CS_SKY_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vDir;
uniform vec3 uTop, uHorizon, uSunDir, uSunColor;
uniform float uDay, uTime;
uniform float uClouds, uCloudCoverage, uCloudDensity, uCloudSpeed, uCloudHeight, uCloudScale;
uniform float uSunWarmth, uSkyIntensity, uAtmosphere;

float hash13(vec3 p){ p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.23)); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float hash21(vec2 p){ p = fract(p * vec2(123.34, 345.45)); p += dot(p, p + 34.345); return fract(p.x * p.y); }
// smooth value noise: continuous in the input, so sub-LSB input jitter cannot decorrelate
// adjacent pixels (the old fract(sin(...)) hash made the cloud layer pure white noise)
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm4(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 4; i++){ v += a * vnoise(p); p = p * 2.02 + vec2(17.3, 9.1); a *= 0.5; } return v; }
float fbm3(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 3; i++){ v += a * vnoise(p); p = p * 2.02 + vec2(17.3, 9.1); a *= 0.5; } return v; }

vec3 csSkyBase(vec3 d){
  float day = uDay;
  float h = clamp(d.y, 0.0, 1.0);
  vec3 zenith = uTop;
  vec3 horizon = mix(uHorizon, uTop * 1.08, 0.38);
  vec3 col = mix(horizon, zenith, pow(h, 0.42));

  float cosT = max(dot(d, uSunDir), 0.0);
  float sunset = exp(-max(uSunDir.y, 0.0) * 6.0) * smoothstep(-0.28, 0.14, uSunDir.y);
  vec3 sunTint = mix(uSunColor, vec3(1.0, 0.60, 0.26), clamp(sunset * uSunWarmth * 1.7, 0.0, 0.85));

  float haze = exp(-max(d.y, 0.0) * 6.5) * (0.35 + 0.65 * day);
  col += sunTint * haze * 0.16 * (0.25 + 0.75 * day) * uAtmosphere;

  float mie = pow(cosT, 6.0) * 0.15 + pow(cosT, 42.0) * 0.32 + pow(cosT, 400.0) * 0.9;
  col += sunTint * mie * (0.35 + 0.65 * day) * uAtmosphere;

  col *= uSkyIntensity;
  col += sunTint * pow(cosT, 3000.0) * 26.0 * smoothstep(-0.05, 0.06, uSunDir.y);

  float night = 1.0 - day;
  if (night > 0.01) {
    float star = step(0.99935, hash13(floor(d * 820.0))) * smoothstep(0.0, 0.28, d.y);
    float twinkle = 0.78 + 0.22 * sin(uTime * 2.0 + d.x * 91.0 + d.z * 37.0);
    col += vec3(0.78, 0.86, 1.0) * star * 2.2 * night * twinkle;
    vec3 moonDir = normalize(-uSunDir + vec3(0.0, 0.002, 0.0));
    float md = max(dot(d, moonDir), 0.0);
    col += vec3(0.92, 0.95, 1.0) * smoothstep(0.99965, 0.99988, md) * 3.4 * night;
    col += vec3(0.45, 0.58, 0.85) * pow(md, 90.0) * 0.35 * night;
  }

  vec3 below = mix(vec3(0.02, 0.028, 0.038), vec3(0.16, 0.18, 0.19), day);
  col = mix(col, below, smoothstep(0.0, -0.10, d.y));
  return col;
}

vec3 csClouds(vec3 d, out float alpha){
  alpha = 0.0;
  if (uClouds < 0.5 || d.y < 0.015) return vec3(0.0);
  float deck = uCloudHeight - cameraPosition.y;
  if (deck <= 1.0) return vec3(0.0);
  float t = deck / d.y;
  if (t > 7000.0) return vec3(0.0);
  vec2 uv = (cameraPosition.xz + d.xz * t) * 0.004 * uCloudScale;
  vec2 wind = vec2(0.85, 0.32) * (uTime * uCloudSpeed * 0.55);

  float cov = clamp(uCloudCoverage, 0.02, 0.98);
  float base = smoothstep(cov, cov + 0.22, fbm4(uv + wind));
  if (base <= 0.002) return vec3(0.0);

  vec2 sunStep = vec2(uSunDir.x, uSunDir.z) * 0.085;
  float shade = fbm3(uv + wind + sunStep) * 0.62 + fbm3(uv + wind + sunStep * 2.6) * 0.38;
  float light = clamp(1.0 - shade * 1.5 * uCloudDensity, 0.08, 1.0);
  light = mix(light, 1.0, 0.18);

  float day = uDay;
  vec3 lit = mix(vec3(0.30, 0.34, 0.42), mix(uSunColor * 1.05, vec3(1.0, 0.985, 0.94), 0.62), day);
  vec3 shadowCol = mix(vec3(0.035, 0.045, 0.065), mix(uTop * 0.62, vec3(0.34, 0.38, 0.47), 0.55), day);
  vec3 col = mix(shadowCol, lit, light);

  float cosT = max(dot(d, uSunDir), 0.0);
  col += (uSunColor * 0.9 + vec3(0.2, 0.12, 0.05)) * pow(cosT, 10.0) * 0.55 * light * (0.25 + 0.75 * day);
  col += vec3(1.0, 0.95, 0.85) * pow(cosT, 3.0) * 0.10 * light * day;

  float horizonFade = smoothstep(0.015, 0.14, d.y);
  float distFade = 1.0 - smoothstep(1800.0, 7000.0, t);
  alpha = clamp(base * horizonFade * distFade * mix(0.55, 1.0, day), 0.0, 0.985);
  return col;
}

void main(){
  vec3 d = normalize(vDir);
  vec3 col = csSkyBase(d);
  float ca;
  vec3 cc = csClouds(d, ca);
  col = mix(col, cc, ca);
  gl_FragColor = vec4(col, 1.0);
}
`;

/* -------------------------------------------------------------------------------------------------
 * Water: fresnel sky reflection + 4-wave analytic normals + sun glitter + depth-based
 * deep/shallow separation + shoreline foam. The scene depth comes from the CS depth prepass
 * (opaque geometry only), so "thickness" = scene depth - water surface depth is the real water depth.
 * ------------------------------------------------------------------------------------------------ */
export const CS_WATER_VERTEX = /* glsl */ `
varying vec3 vWorld; varying vec3 vN; varying float vViewZ;
void main(){
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 vp = viewMatrix * wp;
  vViewZ = -vp.z;
  gl_Position = projectionMatrix * vp;
}
`;

export const CS_WATER_FRAGMENT = /* glsl */ `
precision highp float;
varying vec3 vWorld; varying vec3 vN; varying float vViewZ;
uniform float uTime;
uniform vec3 uSunDir, uDeep, uShallow, uSky, uSkyTop, uSunColor, uFogColor;
uniform float uFog;
uniform sampler2D uDepth;
uniform vec2 uResolution;
uniform float uNear, uFar;
uniform float uWaves, uFresnel, uReflection, uWaveHeight, uFoam;

float hash12(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float noise2(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float fbm2(vec2 p){ float v = 0.0, a = 0.5; for (int i = 0; i < 2; i++){ v += a * noise2(p); p = p * 2.03 + vec2(11.7, 5.3); a *= 0.5; } return v; }
float linearDepth(float d){
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

// one directional wave: adds height and accumulates the surface gradient
void wave(vec2 p, vec2 dir, float freq, float speed, float amp, float t, inout float h, inout vec2 grad){
  float phase = dot(dir, p) * freq + t * speed;
  h += sin(phase) * amp;
  grad += dir * (cos(phase) * amp * freq);
}

void main(){
  vec2 p = vWorld.xz * 0.42;
  float t = uTime * 0.9;
  float h = 0.0;
  vec2 grad = vec2(0.0);
  wave(p, normalize(vec2(1.0, 0.35)), 0.55, 1.15, 0.55, t, h, grad);
  wave(p, normalize(vec2(-0.45, 0.9)), 0.95, 1.55, 0.30, t, h, grad);
  wave(p, normalize(vec2(0.8, -0.6)), 1.85, 2.25, 0.14, t, h, grad);
  wave(p, normalize(vec2(0.2, 1.0)), 3.40, 3.10, 0.06, t, h, grad);
  vec3 N = normalize(vec3(-grad.x * uWaveHeight * uWaves, 1.0, -grad.y * uWaveHeight * uWaves) + vN * 0.15);
  N = normalize(N);

  vec3 V = normalize(cameraPosition - vWorld);
  float ndv = max(dot(N, V), 0.0);
  float fresnel = mix(0.02, 1.0, pow(1.0 - ndv, 5.0));
  fresnel = mix(0.02, fresnel, uFresnel);

  // water depth from the opaque depth prepass (>= far means no sea floor hit)
  float rawDepth = texture2D(uDepth, gl_FragCoord.xy / uResolution).r;
  float sceneZ = linearDepth(rawDepth);
  float thickness = (rawDepth >= 0.99999 || sceneZ < vViewZ) ? 100.0 : (sceneZ - vViewZ);

  float shallow = smoothstep(4.5, 0.35, thickness);
  vec3 body = mix(uDeep, uShallow, clamp(shallow, 0.0, 1.0));
  body = mix(body, body * vec3(0.82, 0.95, 0.92), shallow * 0.35);

  // analytic sky reflection (screen-space reflections are not possible without a colour prepass)
  vec3 R = reflect(-V, N);
  vec3 skyRef = mix(uSky, uSkyTop, pow(clamp(R.y, 0.0, 1.0), 0.6));
  float sunDot = max(dot(R, uSunDir), 0.0);
  skyRef += uSunColor * (pow(sunDot, 90.0) * 0.35 + pow(sunDot, 900.0) * 4.0);
  vec3 col = mix(body, skyRef, clamp(fresnel * uReflection, 0.0, 1.0));

  // sun glitter band + soft specular
  float spec = pow(max(dot(R, uSunDir), 0.0), 320.0);
  float glitter = pow(max(dot(reflect(-V, N), uSunDir), 0.0), 1400.0) * (0.6 + 0.8 * hash12(p * 13.0 + uTime));
  col += uSunColor * spec * 1.6 + uSunColor * glitter * 5.0;

  // shoreline foam from the depth gradient
  float shore = 1.0 - smoothstep(0.05, 1.6, thickness);
  float foamNoise = fbm2(p * 2.2 + vec2(uTime * 0.35, uTime * 0.22));
  float foam = clamp(shore * foamNoise * uFoam * 1.4, 0.0, 0.85);
  col = mix(col, vec3(0.82, 0.90, 0.94), foam);

  float dist = length(cameraPosition - vWorld);
  float fog = clamp(1.0 - exp(-uFog * dist * 1.35), 0.0, 0.92);
  col = mix(col, uFogColor, fog);

  float alpha = clamp(mix(0.62, 0.95, fresnel) * (1.0 - shallow * 0.22) + foam * 0.25, 0.45, 0.97);
  gl_FragColor = vec4(col, alpha);
}
`;

/* -------------------------------------------------------------------------------------------------
 * Final CS composite: SSAO (depth based), CAS-lite sharpen, distance + height fog, ACES/filmic/neutral
 * tone mapping, split toning (warm highlights / cool shadows), temperature, saturation, contrast,
 * vignette. Everything is deterministic and analytic (no temporal accumulation, no TAA).
 * ------------------------------------------------------------------------------------------------ */
export const CS_FINAL_FRAGMENT = /* glsl */ `
precision highp float;
varying vec2 vUv;
uniform sampler2D tScene, tBloom, tRays, tDepth;
uniform vec2 uResolution;
uniform float uNear, uFar;
uniform mat4 uInvViewProj, uView, uViewProj;
uniform vec3 uCamPos, uSunDir, uSunColor, uFogColor, uFogSunColor;
uniform float uExposure, uBloomStrength, uRayStrength, uSaturation, uVignette, uContrast, uTemperature;
uniform float uSplitWarm, uSplitCool, uSharpen, uSsao, uSsaoStrength, uSsaoRadius;
uniform float uFogDensity, uHeightFog, uHeightFalloff, uFogBase;
uniform float uBloomOn, uRaysOn, uToneMap;

float hash12(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }

float linearizeDepth(float d){
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}
vec3 worldFromDepth(vec2 uv, float d){
  vec4 ndc = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 w = uInvViewProj * ndc;
  return w.xyz / max(w.w, 1e-6);
}
float csAo(vec2 uv, vec3 P, float rawDepth, vec2 texel){
  if (uSsao < 0.5 || rawDepth >= 0.99999) return 1.0;
  // normal from reconstructed world positions (finite differences, no derivatives extension needed)
  float dr = texture2D(tDepth, uv + vec2(texel.x, 0.0)).r;
  float du = texture2D(tDepth, uv + vec2(0.0, texel.y)).r;
  vec3 pR = worldFromDepth(uv + vec2(texel.x, 0.0), dr);
  vec3 pU = worldFromDepth(uv + vec2(0.0, texel.y), du);
  vec3 N = normalize(cross(pR - P, pU - P));
  if (dot(N, uCamPos - P) < 0.0) N = -N;
  vec3 T = normalize(abs(N.y) < 0.95 ? cross(N, vec3(0.0, 1.0, 0.0)) : cross(N, vec3(1.0, 0.0, 0.0)));
  vec3 B = cross(N, T);

  float ang = hash12(gl_FragCoord.xy) * 6.2831853;
  float occ = 0.0;
  float wsum = 0.0;
  for (int i = 0; i < 8; i++) {
    float fi = float(i) + 0.5;
    float a = ang + fi * 2.39996323;
    float r = uSsaoRadius * sqrt(fi / 8.0);
    vec3 S = P + (T * cos(a) + B * sin(a)) * r + N * r * 0.4;
    vec4 clip = uViewProj * vec4(S, 1.0);
    if (clip.w <= 1e-4) continue;
    vec2 suv = clip.xy / clip.w * 0.5 + 0.5;
    if (suv.x < 0.002 || suv.x > 0.998 || suv.y < 0.002 || suv.y > 0.998) continue;
    float sd = texture2D(tDepth, suv).r;
    if (sd >= 0.99999) continue;
    vec3 sv = (uView * vec4(S, 1.0)).xyz;
    float expectZ = -sv.z;
    float sampleZ = linearizeDepth(sd);
    float diff = sampleZ - expectZ;
    float w = 1.0 - smoothstep(0.0, uSsaoRadius * 1.8 + 0.5, abs(sampleZ - linearizeDepth(rawDepth)));
    occ += clamp((diff - 0.03) / max(uSsaoRadius, 0.2), 0.0, 1.0) * w;
    wsum += 1.0;
  }
  return clamp(1.0 - (occ / max(wsum, 1.0)) * uSsaoStrength, 0.0, 1.0);
}

vec3 aces(vec3 x){ const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14; return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0); }
vec3 filmic(vec3 x){ x = max(vec3(0.0), x - 0.004); return (x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06); }
vec3 neutral(vec3 x){ return clamp(x / (x + vec3(1.0)) * 1.25, 0.0, 1.0); }
vec3 lin2srgb(vec3 c){ return mix(1.055 * pow(max(c, 0.0), vec3(1.0 / 2.4)) - 0.055, 12.92 * max(c, 0.0), step(max(c, 0.0), vec3(0.0031308))); }

void main(){
  vec2 uv = vUv;
  vec2 texel = 1.0 / uResolution;
  float rawDepth = texture2D(tDepth, uv).r;
  vec3 P = worldFromDepth(uv, rawDepth);

  vec3 c = texture2D(tScene, uv).rgb;

  // CAS-lite: 5-tap HDR unsharp mask (sharpens geometry detail before tone mapping)
  if (uSharpen > 0.001) {
    vec3 blur = (texture2D(tScene, uv - vec2(texel.x, 0.0)).rgb
               + texture2D(tScene, uv + vec2(texel.x, 0.0)).rgb
               + texture2D(tScene, uv - vec2(0.0, texel.y)).rgb
               + texture2D(tScene, uv + vec2(0.0, texel.y)).rgb) * 0.25;
    c = max(c + (c - blur) * uSharpen, vec3(0.0));
  }

  c *= csAo(uv, P, rawDepth, texel);

  c += texture2D(tBloom, uv).rgb * uBloomStrength * uBloomOn;
  c += texture2D(tRays, uv).rgb * vec3(1.0, 0.82, 0.55) * uRayStrength * uRaysOn;

  // analytic distance + height fog (matches CS Reimagined's layered atmosphere)
  if (rawDepth < 0.99999 && (uFogDensity > 1e-6 || uHeightFog > 1e-6)) {
    vec3 vdir = normalize(P - uCamPos);
    float dist = length(P - uCamPos);
    float h0 = exp(-(uCamPos.y - uFogBase) / max(uHeightFalloff, 1e-3));
    float h1 = exp(-(P.y - uFogBase) / max(uHeightFalloff, 1e-3));
    float dy = P.y - uCamPos.y;
    float integral = abs(dy) > 0.05 ? dist * uHeightFalloff * (h0 - h1) / dy : h0 * dist;
    float fogAmount = 1.0 - exp(-(uFogDensity * dist + uHeightFog * max(integral, 0.0)));
    fogAmount = clamp(fogAmount, 0.0, 0.94);
    float sunAmt = pow(max(dot(vdir, uSunDir), 0.0), 3.5);
    vec3 fogCol = mix(uFogColor, uFogSunColor, sunAmt);
    c = mix(c, fogCol, fogAmount);
  }

  c *= uExposure;

  if (uToneMap < 0.5) c = aces(c);
  else if (uToneMap < 1.5) c = filmic(c);
  else c = neutral(c);

  // split toning: warm highlights, cool shadows
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 cool = mix(vec3(1.0), vec3(0.945, 0.98, 1.06), uSplitCool);
  vec3 warm = mix(vec3(1.0), vec3(1.055, 1.005, 0.945), uSplitWarm);
  c *= mix(cool, warm, smoothstep(0.18, 0.9, l));

  c.r *= 1.0 + uTemperature * 0.5;
  c.b *= 1.0 - uTemperature * 0.5;

  c = mix(vec3(dot(c, vec3(0.2126, 0.7152, 0.0722))), c, uSaturation);
  c = (c - 0.5) * uContrast + 0.5;
  c = max(c, 0.0);

  vec2 q = uv - 0.5;
  c *= 1.0 - dot(q, q) * uVignette;
  c = lin2srgb(c);
  gl_FragColor = vec4(c, 1.0);
}
`;
