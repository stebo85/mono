// Gradient precompute. Mirrors the fragment shader in gl/gradient.ts
// statement for statement -- same channel, same stencil, same offsets, same
// encoding -- because the two backends must produce the same image. See
// view/NVGradient.ts for why the estimator is defined by what WebGL2 can do.
//
// This used to be an 8-corner Sobel over the RED channel followed by a
// separate 27-tap blur pass. All three of those diverged from WebGL2: red
// saturates part-way up most colormaps (so the gradient vanished on the
// brightest voxels), the corner stencil has a different gain and frequency
// response than a central difference, and the blur ran on the ENCODED texture,
// averaging already-normalized normals and already-log-compressed magnitudes,
// which biases the magnitude field rather than merely smoothing it.

@group(0) @binding(0) var inputTex: texture_3d<f32>;
@group(0) @binding(1) var outputTex: texture_storage_3d<rgba8unorm, write>;
// A LINEAR, clamp-to-edge sampler. The filtering is not incidental: it is what
// makes the fractional sobelRadius tap a trilinear blend, and therefore what
// replaces the deleted blur pass.
@group(0) @binding(2) var inputSampler: sampler;

// Supplied from view/NVGradient.ts at pipeline creation, so the encoding here
// and the one gl/gradient.ts interpolates into its GLSL cannot drift apart.
override sobelRadius: f32;
override gradEps: f32;
override gradShift: f32;
override gradScale: f32;

// 8, 8, 4 (256) rather than 8, 8, 8 (512) to meet default invocation limits.
@compute @workgroup_size(8, 8, 4)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
	let size = vec3<i32>(textureDimensions(inputTex));
	let pos = vec3<i32>(id);

	if (pos.x >= size.x || pos.y >= size.y || pos.z >= size.z) { return; }

	// Voxel-centre texture coordinate. This is the WebGL2 pass's fragment
	// centre ((i + 0.5) / dim from its full-screen quad) and its coordZ
	// ((z + 0.5) / vz), written as one vector.
	let sizeF = vec3<f32>(size);
	let vPos = (vec3<f32>(pos) + 0.5) / sizeF;
	let d = sobelRadius / sizeF;

	// Three central differences over the colormapped ALPHA channel. Alpha,
	// not red: a LUT's alpha ramp is monotonic in intensity for every
	// colormap, its colour channels are not.
	let gx = textureSampleLevel(inputTex, inputSampler, vPos + vec3f(d.x, 0.0, 0.0), 0.0).a
	       - textureSampleLevel(inputTex, inputSampler, vPos - vec3f(d.x, 0.0, 0.0), 0.0).a;
	let gy = textureSampleLevel(inputTex, inputSampler, vPos + vec3f(0.0, d.y, 0.0), 0.0).a
	       - textureSampleLevel(inputTex, inputSampler, vPos - vec3f(0.0, d.y, 0.0), 0.0).a;
	let gz = textureSampleLevel(inputTex, inputSampler, vPos + vec3f(0.0, 0.0, d.z), 0.0).a
	       - textureSampleLevel(inputTex, inputSampler, vPos - vec3f(0.0, 0.0, d.z), 0.0).a;

	let grad = vec3f(gx, gy, gz);

	// Guarded normalize, NOT normalize(grad + eps). Adding a scalar epsilon to
	// every component biases a flat voxel to the unit vector along (1,1,1) --
	// an arbitrary but perfectly confident normal, which the silhouette term
	// then dots against the view direction and treats as a real surface.
	// Storing vec3(0.0) instead (encoded as 0.5) is what gl/gradient.ts does,
	// and the render shaders' own guarded normalize turns it back into a zero
	// vector, so both backends agree on what "no gradient here" means.
	let len = length(grad);
	var dir = vec3f(0.0);
	if (len > 0.0001) {
		dir = grad / len;
	}

	// Map [-1, 1] to [0, 1] for RGBA8 storage.
	let normalized = dir * 0.5 + 0.5;

	// Alpha carries the gradient MAGNITUDE, read by the render shaders'
	// gradientOpacity. Logarithmic in the squared gradient -- see
	// view/NVGradient.ts for why a linear magnitude makes the feature useless.
	let g2 = dot(grad, grad);
	let magnitude = (log2(g2 + gradEps) + gradShift) * gradScale;

	textureStore(outputTex, pos, vec4f(normalized, magnitude));
}
