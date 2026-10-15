# Sakura: A Year of Life — Architecture

This document is the plan the code was built from. It explains how the scene is
put together, how the seasons drive everything, and where each concern lives.

## 1. Guiding principles

1. **One continuous number drives the world.** The year is a single float
   `year ∈ [0, 1)` (0 = 立春 *Risshun*, the start of spring). Every visual
   parameter is a *cyclic keyframe curve* over that float, so any slider
   position — including the ones between seasons — is a valid, smoothly
   blended state. Nothing "switches"; it only interpolates.
2. **Systems are pure consumers of a shared state.** `seasons.js` produces a
   `SeasonState` object each frame; the tree, particles, island and lighting
   only read it. No system talks to another directly.
3. **The GPU does the animation.** Wind sway, petal/leaf/snow flight, firefly
   wander, koi swimming and water are computed in GLSL from `uTime` and
   per-instance random seeds. The CPU only updates a handful of uniforms per
   frame — no per-particle JS work, no per-frame allocations.
4. **Few draw calls.** The whole tree is one merged mesh; canopy, particles,
   rocks and grass are instanced. Target ≈ 25 draw calls + a small shadow pass.

## 2. Module layout

```
src/
├─ main.js                 Entry: WebGL 2 check, loading veil, dynamic import of app.js
├─ app.js                  Builds the world (reporting progress), frame loop, startup GPU benchmark
├─ styles.css              UI styling (washi paper / sumi ink / vermilion)
├─ core/
│  ├─ renderer.js          WebGLRenderer, camera, OrbitControls, camera clamp,
│  │                       Quality (Low / High / Cinematic presets)
│  ├─ postfx.js            Scene (MSAA, two-phase for refraction) [→ Cinematic] → UnrealBloom → Final [→ SMAA on Low]
│  ├─ finalPass.js         ACES tone mapping, season grade, vignette, grain (all presets)
│  ├─ cinematicPass.js     SSAO, shadow-mapped volumetric fog / god rays, depth of field
│  ├─ shadows.js           12-tap soft PCF patch, shadow-only layer, radius helper
│  ├─ layers.js            Render layers: opaque, shadow-only, late (transparent)
│  ├─ uniforms.js          Shared uniform objects (time, wind, light, snow)
│  ├─ materials.js         enhanceMaterial(): wind / snow / custom patches for
│  │                       built-in three materials via onBeforeCompile
│  ├─ layout.js            World layout + analytic terrain height (JS *and* GLSL)
│  ├─ curves.js            Cyclic scalar / colour keyframe tracks
│  └─ random.js            Seeded PRNG + small noise helpers (deterministic world)
├─ systems/
│  ├─ seasons.js           Year timeline, autoplay, keyframes → SeasonState, 24 sekki
│  ├─ lighting.js          Sun/moon, hemisphere, bounce light, lantern light, fog, day/dusk/night
│  ├─ grading.js           Per-season colour grade → finalPass
│  ├─ sky.js               Sky dome (gradient, soft sun, drifting cirrus, moon, stars) + cloud ring
│  ├─ tree.js              Crown envelope, scaffold seed, gnarl/droop, roots,
│  │                       bark material, blossom/leaf canopy
│  ├─ particles.js         Petals, leaves (instanced), snow + fireflies (points)
│  ├─ island.js            Terrain (mounds, root heave, moss, snow drifts + sparkle),
│  │                       soil/rock strata underside, pond + koi, torii, lantern,
│  │                       stones, floating islets
│  ├─ grass.js             Instanced two-sided seasonal grass
│  ├─ loader.js            Loading veil progress + failure message (no WebGL 2, lost context, errors)
│  └─ ui.js                DOM UI: timeline, sekki caption, autoplay, time of day, controls card, photo mode
├─ tree/
│  ├─ spaceColonization.js Space-colonization growth + pipe-model radii
│  └─ branchMesh.js        Skeleton chains → Catmull-Rom tube mesh
├─ textures/
│  ├─ barkTextures.js      Procedural bark albedo / normal / roughness
│  └─ canvasTextures.js    Procedural sprite atlas (buds / blossoms / leaves), clouds
└─ shaders/
   ├─ common.glsl          hash / value noise / rotation helpers
   ├─ wind.glsl            windOffset(): THE sway function (tree, canopy, grass)
   ├─ snowCover.glsl       snowMask(): upward-facing snow accumulation
   ├─ foliage.vert/.frag   Billboarded canopy sprites (buds → bloom → leaves)
   ├─ falling.vert/.frag   Petal & leaf flight (stateless GPU particles)
   ├─ snow.vert/.frag      Snowfall points
   ├─ firefly.vert/.frag   Additive HDR fireflies (feed the bloom pass)
   ├─ sky.vert/.frag       Gradient sky, soft sun, drifting cirrus, moon, twinkling stars
   ├─ clouds.vert/.frag    Billboard cloud puffs lit by the sky
   ├─ water.vert/.frag     Koi pond: ripples, fresnel, petal rafts, ice
   └─ koi.vert/.frag       Swimming koi with a travelling body wave
```

## 3. Frame loop

```
app.js  tick(dt)
  ├─ seasons.update(dt)            → state  (year, all blended params)
  ├─ lighting.update(state, dt)    → sun/moon, bounce, sky, fog, exposure, bloom tuning
  ├─ grading.update(state, day)    → season grade for the final pass (+ fog light on Cinematic)
  ├─ tree.update(state)            → canopy uniforms (bloom, leaves, autumn, snow)
  ├─ island.update(state, dt)      → grass/snow cover, pond ice, lantern, koi
  ├─ particles.update(state)       → emission rates per particle family
  ├─ ui.update(state)              → slider thumb, season + sekki caption
  ├─ controls.update()
  └─ postfx.render()               → [cinematic] → bloom → tone map + grade + vignette + grain
```

`uTime`, `uWindStrength` and `uWindDir` live in `core/uniforms.js` as shared
`{ value }` objects. Every material that sways references the *same* objects,
so updating them once per frame moves the whole world coherently.

## 4. The season model

`year` is unbounded internally (autoplay just keeps adding); everything samples
`fract(year)`. The slider writes a *target* and the real year eases toward it,
so even a big jump on the slider plays as a short, smooth transition.

Key curves (x = year, 0 → 1, wraps):

| Parameter        | Shape                                                        |
|------------------|--------------------------------------------------------------|
| `blossoms`       | buds appear 0.025 → 0.09, hold, shed 0.19 → 0.29 (per sprite)|
| `bloom`          | buds open 0.07 → 0.15 (full bloom ~0.15–0.21)                |
| `petalRate`      | drifting petals during bloom, a storm (花吹雪) while shedding  |
| `petalCover`     | fallen petals on grass + rafts on the pond, 0.15 → 0.42      |
| `leaves`         | hazakura leaves 0.2 → 0.33, hold, drop 0.71 → 0.825          |
| `autumn`         | green → gold/orange/crimson 0.58 → 0.72                      |
| `leafFallRate`   | falling leaves peak 0.7 → 0.82                               |
| `snowfall`       | 0.775 → 0.035 (wraps)                                        |
| `snowCover`      | accumulates 0.795 → 0.95, melts 0.00 → 0.075 (wraps)         |
| `fireflies`      | early summer 0.31 → 0.56 (visible at dusk / night only)      |
| `pondIce`        | 0.845 → 0.05 (wraps) — the pond freezes in deep winter       |
| `wind`           | breezy spring, calm summer, gusty autumn                     |
| colours          | grass, sky tint, sun tint per season                         |

Per-instance thresholds turn a single 0→1 parameter into an *organic*
transition: each canopy sprite has its own random threshold, so blossoms open,
leaves turn and fall one by one rather than all at once.

The UI also maps `year` onto the 24 *sekki* (二十四節気, the traditional
Japanese solar terms) — 1/24 of the slider each — for the caption under the
timeline.

## 5. Systems in detail

### Tree (`tree.js` + `tree/spaceColonization.js` + `tree/branchMesh.js`)
* **Envelope** — ~4,000 attraction points fill a lumpy (fbm), flat-bottomed,
  umbrella-shaped crown that leans out over the pond. The crown has an open
  interior, and the column above the trunk is left empty so no central leader
  forms.
* **Seed** — a hand-placed start skeleton: a short, slightly leaning trunk that
  splits into four ascending scaffold limbs, plus one long, low limb reaching
  over the water. This gives the low split typical of a Somei-Yoshino.
* **Growth** — space colonization (Runions et al. 2007). Each attraction point
  caches its closest node, and a spatial hash finds the nodes added in the last
  iteration, so growth takes milliseconds in JS.
* **Radii** — pipe model, r^n = Σ r_child^n with n ≈ 2.1, remapped so the
  trunk reads ~0.42.
* **Re-pose** — every joint bends its subtree. *Gnarl* adds small random kinks
  on old wood. *Droop* is proportional to lever arm (how horizontal the
  segment is) × flexibility (thin = soft), so outer branches arch and weep.
* **Chains** — each chain follows its thickest child; side children start new
  chains at a junction on the parent's axis.
* **Mesh** — each chain is a centripetal Catmull-Rom curve resampled into
  rings with parallel-transport frames:
  * Every branch is a closed, outward-wound tube: at least 8 sides, a flat cap
    sealing its base (trunk base, root ends) and a cone or low dome at its end.
    Winding is counter-clockwise seen from outside, matching the outward
    normals; a mesh audit finds 0 open edges, and all but 5 buried collar
    triangles agree with their normals.
  * Ring resolution drops as a branch thins; rings of different resolution are
    zipper-stitched, so there are no cracks.
  * Where a thick branch would bend tighter than ~1.4× its radius, its rings
    would overlap and fold inside-out, so the chain ends there and every child
    leaves with a collar (a true fork).
  * Child bases get a flared collar, and their normals blend into the parent's
    surface normal, so junctions read as one surface.
  * The trunk has a root flare with five buttress lobes peaking at ground
    level, plus a few half-buried surface roots.
  * Normals are analytic, including taper and lobes.
  * Attributes: `aFlex` (wind) and `aAxis` (ring centre).
* **Bark** — procedural tileable maps: albedo, a normal map from a height
  field, and roughness. They show cherry bark's horizontal lenticels (raised
  corky dashes with a dark slit) and peel bands. A vertex tint warms young twigs.
* **Material** — `MeshStandardMaterial` + `onBeforeCompile`:
  * `windOffset()` sway.
  * `snowMask()`, so snow gathers on branch tops.
  * Minimum twig width: a vertex pass widens any tube whose projected radius is
    under ~0.6 px, using `aAxis`, so far twigs stay continuous lines.
  * A matching `customDepthMaterial` keeps shadows in sync with the sway.
* **Canopy** — blossoms and leaves attach to twig samples of the mesh:
  * Ring centres with r < 0.03 plus every tip, thinned to a steady ~1,250 points.
  * Each point carries two sprays per layer, spread *along* the branch (up to
    ±0.45 units along its chain), never into the air beside it. Every spray's
    hub lies on the rendered branch axis, and it takes that point's wind
    weight, so it sways with the wood. `__sakura.checkSprayAttachment()`
    measures hub → bark distance for every visible spray across seasons and
    wind phases (all 0).
  * Two instanced layers (blossoms, leaves) share `foliage.vert/.frag`,
    selected with `#define`s. Billboarding happens in view space.
  * Canopy shadows come from half-density proxies on a shadow-only layer.

### Particles (`particles.js`)
Stateless GPU particles: a particle's position is a pure function of
`(uTime, seed)`. Age = `fract((uTime + offset) / life)`; the integer cycle
re-hashes the seed so every lap spawns somewhere new. Emission rate is a
uniform — each particle compares a per-cycle hash against it and fades
accordingly.
* **Petals / leaves** — instanced cupped-petal / leaf meshes; spawn in the crown,
  fall with wind drift + spiral flutter + tumbling rotation, *land* on the
  island dome (flatten, rest, fade) or keep falling past the island's edge.
* **Snow** — `Points` with soft discs, vertical wrap, sinusoidal drift.
* **Fireflies** — additive HDR points (> 1.0) that wander and blink; they are
  what the bloom pass picks up at dusk.

### Pond (`island.js` + `water.frag` + `koi.vert`)
* **Bowl** — ~0.65 deep with a shelving bank. The floor (in the ground
  shader) runs from a damp bank to sandy shallows to dark silt, mottled with
  pebbles. On High it carries animated caustics: two layers of drifting
  Worley cells, bright where neighbouring cells meet, fading with depth and
  under ice.
* **Water** — soft analytic ripples (three slow swells + one noise octave)
  with a fresnel sky reflection, a sun glint and a bright waterline. Colour
  depends on how far the view ray travels through the water, with red absorbed
  first; the path is capped so the shallow-swimming koi keep their colours.
  * *High* — the scene pass first renders the opaque scene (layer 0) into the
    MSAA target. It then draws the late layer (water, clouds, snow, fireflies)
    into the same target. The water samples the frame's resolved texture,
    offset by the ripple normal. With MSAA, the draw buffer and the resolved
    texture are separate attachments, so this needs no copy and no extra scene
    render.
  * *Low* — an alpha-blended surface tinted the same way.
* **Koi** — five instanced fish, all motion in the vertex shader:
  * A looping, slightly figure-of-eight path per fish.
  * Glide-and-stroke speed.
  * A body wave whose phase follows distance travelled.
  * A lagging tail-fan ripple and flapping pectoral fins.
  * Kept between the floor and the surface.
* **Lily pads** — notched, cupped pads in two clusters that bob and turn. They
  die back under ice and snow, and two of them flower in early summer.
* **Edge** — a rim of stones, a few half-submerged at the waterline, and
  pebbles on the floor (all one instanced draw).

### Land (`island.js` + `grass.js`)
* **Relief** — the shared analytic `terrainHeight()` (JS + GLSL) gains
  gentle mounds and a long, low swell. They are masked to exactly zero within
  3 units of the trunk and around the pond, so neither the tree (whose roots
  follow the ground) nor the pond moves. The mesh adds fine noise relief on top.
* **Roots in the soil** — the tree exposes its surface-root paths (read-only),
  and the island heaves soil shoulders beside them. A per-vertex mask paints
  bare earth along the roots and around the trunk; no grass grows there.
* **Per-vertex land data** — `aLand` = (hollowness, bare soil, inland).
  Hollowness is how far a point sits below the ground 0.8 units around it.
* **Baked noise** — a rock-proximity channel joins the baked noise. It is
  computed from every stone, the lantern and the torii posts, and drives both
  moss and snow drifts.
* **Ground shader**:
  * Exposed soil wherever the rim falls away steeply.
  * Moss in the damp ring around the pond and beside stones.
  * Stones grow moss on their upper faces.
* **Snow**:
  * The ground surface rises with the snow (vertex), deepest in hollows and
    against stones. There is none on slopes, underwater, or at the rim, which
    must keep meeting the underside.
  * It arrives first in the same places.
  * High adds a glint per sparse "ice crystal" cell with its own facet,
    scaled by the direct sunlight the pixel received (so none in shadow).
  * The glint is written branch-free: a branched version produced dark
    pixels on the GT 730's driver (ANGLE / D3D11).
* **Underside** — a shader, not vertex colours: a humus band under the
  grassy rim with hanging root threads, then tilted, warped rock strata with
  seams and grain, darkening toward the tip.
* **Grass** — instanced tufts of curved blades, planted clear of water, soil,
  stones and paths:
  * Two-sided: three flips the normal on back faces, and the shader then tilts
    it toward the sky.
  * Moves with the shared wind and flutters.
  * Seasonal: fresh spring tips, per-blade drying to straw, frosted tips at the
    turn of winter, sinking and finally buried under snow.
  * Back-lit blades glow a little.
  * High: 12,000 tufts × 4 blades × 4 segments. Low: 4,200 tufts × 3 blades ×
    2 segments. Both share the per-tuft data.

### Island (`island.js`)
Polar-grid terrain (dome + noise + pond depression) with snow/grass/fallen
petals done in shader; noise-displaced rocky underside with strata colouring;
instanced grass tufts that sway and sink under snow; torii and *tōrō* lantern
built from primitives (lantern window is emissive → bloom at night); koi
animated in the vertex shader; water shader with ripples, fresnel, sun glint,
floating petal rafts (*hanaikada*) and winter ice.

### Lighting (`lighting.js` + `sky.js`)
One directional light acts as sun *and* moon (direction/colour/intensity
interpolate through dusk), plus a hemisphere light and the lantern point
light. A second, shadowless directional light shines *up* from the sunlit
cloud sea (horizon-coloured, warmed by the sun) so the island's underside,
which faces away from sun and sky, reads without flattening the lit top.
`sky.js` owns the sky dome shader and the cloud ring; lighting feeds it
the blended palette. The dome has a soft sun (disc, aureole and a broad
glow) and a layer of high cirrus that drifts slowly and is lit warm by a low
sun, so the sky always agrees with the light at day, dusk and night. Day/night is a second continuous float `dayMix` that
eases toward 0 or 1; season tints multiply on top. Fog colour always tracks
the horizon so the floating island melts into the sky.

### Post-processing (`postfx.js`)
A custom scene pass renders into its *own* 4× MSAA half-float target and
resolves it once into the composer's single-sampled buffer → `UnrealBloomPass`
(mip chain from quarter resolution; threshold tuned so only HDR emitters —
fireflies, lantern, sun glints — glow strongly; strength rises at night) →
`FinalPass` → `SMAAPass` (Low preset only, which has no MSAA).

`FinalPass` (finalPass.js) replaces three's OutputPass at the same cost, on
every preset: white balance → ACES filmic tone mapping (exposure eases from
1.0 by day to 1.45 at night) → saturation, contrast and shadow/highlight
split-toning → a soft, aspect-correct vignette → sRGB → a very light animated
grain, strongest in the mid-tones. `grading.js` keys the grade over the year
like any season curve: soft pink-warm spring, saturated summer, amber autumn,
cool desaturated winter. The grade eases toward neutral at night.

The **Cinematic** preset inserts `CinematicPass` between the scene and bloom.
The scene target gets a depth texture, and four full-screen passes run:
* **SSAO** (half resolution): 12 hemisphere taps, normals rebuilt from depth,
  a range check so far-off geometry never darkens what stands in front of it,
  then a 3×3 blur.
* **Volumetric fog / god rays** (half resolution): a 24-step jittered ray
  march through a low height fog. Each step looks up the sun's own shadow map,
  so canopy and trunk shadows carve shafts into the haze. The phase function
  is a capped Henyey-Greenstein. Haze density and shaft strength fall as the
  sun sets, so a low sun glows instead of blowing out the frame.
* **Composite**: colour × AO × fog transmittance + in-scattered light.
* **Depth of field**: 16 Vogel-disc taps, far field only. The circle of
  confusion grows with relative distance *beyond* the orbit target, so focus
  follows it and anything nearer — grass in front of a low camera — stays sharp.
  Each tap is weighted by its own blur, so in-focus edges do not smear into
  the blurred background. On High the scene pass runs in two phases (opaque, then the late
layer) so the pond can refract the resolved opaque image; see *Pond*.
Keeping MSAA out of the composer's ping-pong buffers matters: profiling showed
that otherwise every post pass writes to and re-resolves a multisampled
half-float buffer. The cloud bank behind the timeline is a CSS overlay (free).

### Startup (`main.js` → `app.js`, `loader.js`)
`main.js` is a ~3 kB entry chunk. It probes for WebGL 2 and, if it is missing,
shows a short explanation instead of a blank page. Otherwise it dynamically
imports `app.js` (three.js and the world). `app.js` uses top-level `await`
between construction steps (stage, island, tree, grass, particles, shader
compile, benchmark), yielding a paint each time so the veil’s progress line
advances. A failed import, a failed context, or a lost WebGL context all end
in the same calm failure message.

### UI (`ui.js`)
Plain DOM + CSS: vertical title, a brush-line timeline with 春 夏 秋 冬
markers and a hanko-seal thumb, sekki caption, autoplay and day/night buttons,
keyboard shortcuts. A Controls card (orbit, zoom, timeline, quality, photo
mode) fades in when the veil lifts and out after ~7 s. Photo mode (camera button or `P`) fades the whole UI
out for clean screenshots. Orbiting still works, and an exit chip appears
while the mouse moves (`Esc` also exits). The UI only calls the public APIs
of `seasons` and `lighting`.

## 6. Performance budget (60 fps on a mid-range laptop)

| Item                    | Budget / technique                                  |
|-------------------------|-----------------------------------------------------|
| Draw calls              | ~25 (merged tree, instanced everything else)        |
| Triangles               | < 150 k                                             |
| Shadow map              | 1 × 2048² at ultra, 1024² otherwise, tight frustum  |
| Particles               | 1.4 k petals, 750 leaves, 3.2 k snow, 110 fireflies — all GPU |
| Bloom                   | Unreal bloom from quarter resolution                |
| Sky                     | drawn after opaques on the far plane → early-z culls covered pixels |
| CPU per frame           | ~30 uniform writes; no allocations in the loop      |

**Quality presets** (`Quality` in renderer.js). Every expensive effect is gated:

| Preset    | Pixel ratio (devicePixelRatio cap) | Anti-aliasing | Shadow map | Pond | Post |
|-----------|------------------------------------|---------------|------------|------|------|
| cinematic | up to 2×                           | 4× MSAA       | 2048²      | refraction + caustics | + SSAO, fog / god rays, DOF |
| high      | up to 2×                           | 4× MSAA       | 2048²      | refraction + caustics | bloom, grade, vignette, grain |
| low       | 1×                                 | SMAA          | 1024²      | alpha-blended, no caustics | bloom, grade, vignette, grain |

High also has dense, fine grass (12k tufts) and snow sparkle. Low has 4.2k coarser
tufts and no sparkle.

A GPU-synced benchmark behind the loading veil renders High; under 30 fps the
app starts on Low. Three seconds under 30 fps at runtime also drops to Low.
`?quality=high|low|cinematic` pins a preset, and a pinned preset is never
changed at runtime. Cinematic is opt-in only: the benchmark never picks it.

**Camera** — the orbit camera zooms in to 3.5 units; `clampCamera()` keeps it
0.35 above the terrain or the pond surface and out of the trunk.

**Optimizations made to afford MSAA**:
* The canopy casts shadows through half-density proxies. Canopy sprites were
  most of the shadow-map fill.
* The ground's ~17 value-noise evaluations per pixel are baked once into
  mipmapped textures. That saved ~5 ms on the GT 730, and the mipmaps also stop
  distant speckle from shimmering.
* Only "ultra" uses a 2048² shadow map. The 12-tap filter keeps 1024² soft.

**Measured** (GeForce GT 730, 1280×720, GPU-synced, summer — the heaviest
season):
* High — 23.6 ms (default view), 24.8 ms (grass level), 23.6 ms (pond close-up
  in stage C).
* Low — 12.6 ms (default view), 15.0 ms (grass level). Low holds 60 fps on
  that card.
* Stage E, default view, summer / winter: Low 11.2 / 9.6 ms, High 23.4 /
  18.5 ms, Cinematic 27.2 / 25.5 ms. The final pass replaced OutputPass, so
  grading, vignette and grain cost Low and High nothing measurable. On that card, MSAA's cost is memory bandwidth spread
across all geometry, and is about the same at 2× and 4×.

## 7. Build stages

1. Scaffold — Vite, renderer, camera, controls, frame loop.
2. Core + seasons — curves, PRNG, shared uniforms, timeline state.
3. Lighting + sky + post-processing.
4. Island — terrain, underside, pond + koi, torii, lantern, grass, rocks.
5. Tree — L-system, tube mesh, wind, canopy layers (v1; replaced in refinement stage A).
6. Particles — petals, leaves, snow, fireflies.
7. UI — timeline, controls, captions, loading veil.
8. Polish + performance pass + README.

### Refinement (cinematic pass)

A. Tree — space colonization, Catmull-Rom tubes, junction blending, root
   flare, procedural bark maps, minimum twig width.
B. Edge quality — MSAA at every level, devicePixelRatio up to 2×, SMAA
   fallback, 12-tap soft PCF with a fixed world-space penumbra, tighter shadow
   frustum.
C. Pond — depth colour, refraction and caustics (High), soft ripples, koi
   with shader-driven swimming, lily pads, waterline stones; Low/High presets;
   zoom to 3.5 with a terrain/water/trunk camera clamp.
D. Land — mounds, root heave and bare soil, humus/strata underside, moss,
   instanced two-sided seasonal grass, snow drifts and sparkle.
E. Cinematic polish — final pass with ACES tone mapping, per-season grade,
   vignette and grain on every preset; soft sun and drifting cirrus; bounce
   light under the island; opt-in Cinematic preset (SSAO, shadow-mapped
   volumetric fog / god rays, DOF focused on the orbit target); photo mode.
F. Portfolio packaging — far-field-only DOF, Controls card, loading progress
   and WebGL fallback (entry split into main.js + app.js), relative base path
   with Vercel and GitHub Pages configs, README with screenshots.
