interface Env {
  OPENAI_API_KEY: string;
  CORS_ORIGIN?: string;
}

type Quality = "low" | "medium" | "high";
type HairColor = "preserve" | "black" | "brown" | "blonde" | "red" | "gray" | "white";
type Glasses = "preserve" | "add" | "remove";

interface AgeParams {
  age_delta: number;
  intensity: number;
  hair_color: HairColor;
  glasses: Glasses;
  baldness: number;
  blemish_fix: number;
  skin_texture: number;
  quality: Quality;
  preserve_identity: boolean;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const OPENAI_IMAGE_EDITS_URL = "https://api.openai.com/v1/images/edits";
const OPENAI_EDITS_MODEL = "dall-e-2";
const PROBE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO7Zb+0AAAAASUVORK5CYII=";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = buildCorsHeaders(env.CORS_ORIGIN ?? "*");
    const debugEnabled = isDebugRequest(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/api/capabilities") {
      return handleCapabilitiesRequest(url, env, corsHeaders);
    }

    if (request.method !== "POST" || url.pathname !== "/api/age-face") {
      return json(
        withDebug(
          {
            error: { code: "NOT_FOUND", message: "Route not found" },
            available_routes: [
              { method: "GET", path: "/api/capabilities" },
              { method: "POST", path: "/api/age-face" }
            ]
          },
          debugEnabled,
          null
        ),
        404,
        corsHeaders
      );
    }

    try {
      if (!env.OPENAI_API_KEY) {
        return json(
          withDebug({ error: { code: "CONFIG_ERROR", message: "Missing OPENAI_API_KEY" } }, debugEnabled, null),
          500,
          corsHeaders
        );
      }

      const formData = await request.formData();
      const image = formData.get("image");
      const rawParams = formData.get("params");
      const mask = formData.get("mask");

      if (!(image instanceof File)) {
        return json(
          withDebug({ error: { code: "INVALID_INPUT", message: "image is required" } }, debugEnabled, null),
          400,
          corsHeaders
        );
      }

      if (image.type !== "image/png") {
        return json(
          withDebug({ error: { code: "INVALID_INPUT", message: "image must be image/png for this model" } }, debugEnabled, buildInputDebug(image, null, null)),
          400,
          corsHeaders
        );
      }

      if (image.size > MAX_IMAGE_BYTES) {
        return json(
          withDebug({ error: { code: "INVALID_INPUT", message: "image exceeds 4MB" } }, debugEnabled, buildInputDebug(image, null, null)),
          400,
          corsHeaders
        );
      }

      let maskFile: File | null = null;
      if (mask != null) {
        if (!(mask instanceof File)) {
          return json(
            withDebug({ error: { code: "INVALID_INPUT", message: "mask must be a file when provided" } }, debugEnabled, buildInputDebug(image, null, null)),
            400,
            corsHeaders
          );
        }
        if (mask.type !== "image/png") {
          return json(
            withDebug({ error: { code: "INVALID_INPUT", message: "mask must be image/png" } }, debugEnabled, buildInputDebug(image, null, mask)),
            400,
            corsHeaders
          );
        }
        if (mask.size > MAX_IMAGE_BYTES) {
          return json(
            withDebug({ error: { code: "INVALID_INPUT", message: "mask exceeds 4MB" } }, debugEnabled, buildInputDebug(image, null, mask)),
            400,
            corsHeaders
          );
        }
        maskFile = mask;
      }

      if (typeof rawParams !== "string") {
        return json(
          withDebug({ error: { code: "INVALID_INPUT", message: "params must be a JSON string" } }, debugEnabled, buildInputDebug(image, null, maskFile)),
          400,
          corsHeaders
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawParams);
      } catch {
        return json(
          withDebug({ error: { code: "INVALID_INPUT", message: "params must be valid JSON" } }, debugEnabled, buildInputDebug(image, null, maskFile)),
          400,
          corsHeaders
        );
      }

      const params = validateParams(parsed);
      const prompt = buildPrompt(params);
      const inputDebug = buildInputDebug(image, params, maskFile);

      const openAiForm = new FormData();
      openAiForm.append("model", OPENAI_EDITS_MODEL);
      openAiForm.append("prompt", prompt);
      openAiForm.append("image", image, image.name || "input.png");
      if (maskFile) openAiForm.append("mask", maskFile, maskFile.name || "mask.png");
      openAiForm.append("size", "1024x1024");
      openAiForm.append("response_format", "b64_json");

      const started = Date.now();
      const openAiResponse = await fetch(OPENAI_IMAGE_EDITS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: openAiForm
      });

      const openAiBody = (await openAiResponse.json()) as Record<string, unknown>;
      const upstreamDebug = {
        upstream_status: openAiResponse.status,
        upstream_status_text: openAiResponse.statusText,
        upstream_request_id: openAiResponse.headers.get("x-request-id"),
        upstream_processing_ms: openAiResponse.headers.get("openai-processing-ms"),
        upstream_error: extractOpenAiErrorDetails(openAiBody)
      };

      if (!openAiResponse.ok) {
        return json(
          withDebug(
            {
              error: {
                code: "UPSTREAM_ERROR",
                message: extractOpenAiError(openAiBody) ?? "OpenAI request failed"
              }
            },
            debugEnabled,
            {
              input: inputDebug,
              upstream: upstreamDebug
            }
          ),
          openAiResponse.status,
          corsHeaders
        );
      }

      const firstImage = extractImagePayload(openAiBody);
      if (!firstImage) {
        return json(
          withDebug(
            { error: { code: "UPSTREAM_ERROR", message: "No image output returned by model" } },
            debugEnabled,
            {
              input: inputDebug,
              upstream: upstreamDebug
            }
          ),
          502,
          corsHeaders
        );
      }

      const cleanedBase64 = firstImage.b64.replace(/\s+/g, "");
      const mimeType = inferMimeTypeFromBase64(cleanedBase64, firstImage.mime);

      return json(
        withDebug(
          {
            id: (openAiBody.id as string | undefined) ?? crypto.randomUUID(),
            image_base64: cleanedBase64,
            mime_type: mimeType,
            image_data_url: `data:${mimeType};base64,${cleanedBase64}`,
            meta: {
              model: OPENAI_EDITS_MODEL,
              quality: params.quality,
              elapsed_ms: Date.now() - started
            }
          },
          debugEnabled,
          {
            input: inputDebug,
            upstream: upstreamDebug,
            output: {
              mime_type: mimeType,
              base64_length: cleanedBase64.length
            }
          }
        ),
        200,
        corsHeaders
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return json(
        withDebug({ error: { code: "INTERNAL_ERROR", message } }, debugEnabled, null),
        500,
        corsHeaders
      );
    }
  }
};

function json(body: unknown, status: number, corsHeaders: Headers): Response {
  const headers = new Headers(corsHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(body), { status, headers });
}

function buildCorsHeaders(allowedOrigin: string): Headers {
  const headers = new Headers();
  headers.set("access-control-allow-origin", allowedOrigin);
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization, x-ageme-debug");
  headers.set("access-control-max-age", "86400");
  return headers;
}

async function handleCapabilitiesRequest(url: URL, env: Env, corsHeaders: Headers): Promise<Response> {
  const shouldProbe = ["1", "true", "yes"].includes((url.searchParams.get("probe") || "").toLowerCase());

  const body: Record<string, unknown> = {
    api: {
      routes: [
        { method: "GET", path: "/api/capabilities" },
        { method: "POST", path: "/api/age-face" }
      ]
    },
    openai: {
      endpoint: OPENAI_IMAGE_EDITS_URL,
      model: OPENAI_EDITS_MODEL
    },
    constraints: {
      supported_input_mime_types: ["image/png"],
      accepted_params_for_upstream: ["model", "prompt", "image", "size", "response_format"],
      rejected_param_examples: ["quality"],
      max_image_bytes: MAX_IMAGE_BYTES
    },
    probe: {
      available: true,
      executed: false,
      note: "Use ?probe=1 for a live upstream compatibility check (may incur image generation cost)."
    }
  };

  if (!shouldProbe) {
    return json(body, 200, corsHeaders);
  }

  if (!env.OPENAI_API_KEY) {
    body.probe = {
      available: true,
      executed: false,
      ok: false,
      error: "Missing OPENAI_API_KEY"
    };
    return json(body, 500, corsHeaders);
  }

  const started = Date.now();
  const probeBytes = Uint8Array.from(atob(PROBE_PNG_BASE64), (c) => c.charCodeAt(0));
  const probeFile = new File([probeBytes], "probe.png", { type: "image/png" });

  const probeForm = new FormData();
  probeForm.append("model", OPENAI_EDITS_MODEL);
  probeForm.append("prompt", "Slightly adjust brightness while preserving the same tiny image.");
  probeForm.append("image", probeFile, "probe.png");
  probeForm.append("size", "256x256");
  probeForm.append("response_format", "b64_json");

  const probeResponse = await fetch(OPENAI_IMAGE_EDITS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.OPENAI_API_KEY}`
    },
    body: probeForm
  });

  const probeRaw = (await probeResponse.json()) as Record<string, unknown>;
  const probeImage = extractImagePayload(probeRaw);

  body.probe = {
    available: true,
    executed: true,
    ok: probeResponse.ok,
    elapsed_ms: Date.now() - started,
    upstream_status: probeResponse.status,
    upstream_status_text: probeResponse.statusText,
    upstream_request_id: probeResponse.headers.get("x-request-id"),
    upstream_processing_ms: probeResponse.headers.get("openai-processing-ms"),
    upstream_error: extractOpenAiErrorDetails(probeRaw),
    output: probeImage
      ? {
          returned_image: true,
          mime_type: inferMimeTypeFromBase64(probeImage.b64, probeImage.mime),
          base64_length: probeImage.b64.length
        }
      : {
          returned_image: false
        }
  };

  return json(body, probeResponse.ok ? 200 : 502, corsHeaders);
}

function isDebugRequest(request: Request): boolean {
  return request.headers.get("x-ageme-debug") === "1";
}

function withDebug<T extends Record<string, unknown>>(body: T, enabled: boolean, debug: unknown): T & { debug?: unknown } {
  if (!enabled) {
    return body;
  }
  return { ...body, debug };
}

function buildInputDebug(image: File, params: AgeParams | null, mask: File | null): Record<string, unknown> {
  return {
    image: {
      name: image.name,
      type: image.type,
      size: image.size,
      last_modified: image.lastModified
    },
    mask: mask
      ? {
          name: mask.name,
          type: mask.type,
          size: mask.size,
          last_modified: mask.lastModified
        }
      : null,
    params,
    timestamp: new Date().toISOString()
  };
}

function buildPrompt(params: AgeParams): string {
  const ageDirection = params.age_delta >= 0 ? "older" : "younger";
  const ageYears = Math.abs(params.age_delta);

  const instructions = [
    "Edit the provided portrait photo.",
    `Make the subject appear ${ageYears} years ${ageDirection} with intensity ${params.intensity.toFixed(2)}.`,
    "The age transformation must be clearly visible and noticeable at first glance.",
    "Apply realistic age cues (skin detail, facial contours, hair aging/de-aging cues) consistent with the requested direction.",
    `Hair color: ${params.hair_color}.`,
    `Glasses: ${params.glasses}.`,
    `Baldness level: ${params.baldness}/100.`,
    `Blemish correction level: ${params.blemish_fix}/100.`,
    `Skin texture shift: ${params.skin_texture} on a scale from -100 to 100.`,
    `Requested output quality profile: ${params.quality}.`,
    params.preserve_identity
      ? "Preserve identity and expression, but do not under-apply the requested age change."
      : "Allow moderate identity changes while keeping a photorealistic result.",
    "Do not add extra people, text, logos, or stylization. Keep it photorealistic."
  ];

  return instructions.join(" ");
}

function validateParams(parsed: unknown): AgeParams {
  if (!parsed || typeof parsed !== "object") {
    throw new Error("params must be a JSON object");
  }

  const obj = parsed as Record<string, unknown>;

  return {
    age_delta: numberInRange(obj.age_delta, -40, 40, "age_delta"),
    intensity: numberInRange(obj.intensity, 0, 1, "intensity"),
    hair_color: enumValue(obj.hair_color, ["preserve", "black", "brown", "blonde", "red", "gray", "white"], "hair_color"),
    glasses: enumValue(obj.glasses, ["preserve", "add", "remove"], "glasses"),
    baldness: numberInRange(obj.baldness, 0, 100, "baldness"),
    blemish_fix: numberInRange(obj.blemish_fix, 0, 100, "blemish_fix"),
    skin_texture: numberInRange(obj.skin_texture, -100, 100, "skin_texture"),
    quality: enumValue(obj.quality, ["low", "medium", "high"], "quality"),
    preserve_identity: booleanValue(obj.preserve_identity, "preserve_identity")
  };
}

function numberInRange(value: unknown, min: number, max: number, key: string): number {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`${key} must be a number`);
  }
  if (value < min || value > max) {
    throw new Error(`${key} must be between ${min} and ${max}`);
  }
  return value;
}

function booleanValue(value: unknown, key: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be boolean`);
  }
  return value;
}

function enumValue<T extends string>(value: unknown, allowed: T[], key: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(`${key} is invalid`);
  }
  return value as T;
}

function extractOpenAiError(body: Record<string, unknown>): string | null {
  const errorObj = body.error as Record<string, unknown> | undefined;
  const message = errorObj?.message;
  return typeof message === "string" ? message : null;
}

function extractOpenAiErrorDetails(body: Record<string, unknown>): Record<string, unknown> | null {
  const errorObj = body.error as Record<string, unknown> | undefined;
  if (!errorObj || typeof errorObj !== "object") {
    return null;
  }

  return {
    message: typeof errorObj.message === "string" ? errorObj.message : null,
    type: typeof errorObj.type === "string" ? errorObj.type : null,
    code: typeof errorObj.code === "string" ? errorObj.code : null,
    param: typeof errorObj.param === "string" ? errorObj.param : null
  };
}

function extractImagePayload(body: Record<string, unknown>): { b64: string; mime: string } | null {
  const data = body.data;
  if (!Array.isArray(data) || data.length === 0) {
    return null;
  }

  const first = data[0] as Record<string, unknown>;
  const b64 = first.b64_json;
  if (typeof b64 !== "string" || b64.length === 0) {
    return null;
  }

  const mime = typeof first.mime_type === "string" ? first.mime_type : "image/png";
  return { b64, mime };
}

function inferMimeTypeFromBase64(base64: string, fallback: string): string {
  try {
    const cleaned = base64.replace(/\s+/g, "");
    const bytes = Uint8Array.from(atob(cleaned.slice(0, 64)), (c) => c.charCodeAt(0));
    if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
      return "image/png";
    }
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    ) {
      return "image/webp";
    }
  } catch (_) {
    // Fall through to fallback.
  }

  return typeof fallback === "string" && fallback.startsWith("image/") ? fallback : "image/png";
}
