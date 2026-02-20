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

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = buildCorsHeaders(env.CORS_ORIGIN ?? "*");

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== "/api/age-face") {
      return json({ error: { code: "NOT_FOUND", message: "Route not found" } }, 404, corsHeaders);
    }

    try {
      if (!env.OPENAI_API_KEY) {
        return json(
          { error: { code: "CONFIG_ERROR", message: "Missing OPENAI_API_KEY" } },
          500,
          corsHeaders
        );
      }

      const formData = await request.formData();
      const image = formData.get("image");
      const rawParams = formData.get("params");

      if (!(image instanceof File)) {
        return json(
          { error: { code: "INVALID_INPUT", message: "image is required" } },
          400,
          corsHeaders
        );
      }

      if (!image.type.startsWith("image/")) {
        return json(
          { error: { code: "INVALID_INPUT", message: "image must be a valid image type" } },
          400,
          corsHeaders
        );
      }

      if (image.size > MAX_IMAGE_BYTES) {
        return json(
          { error: { code: "INVALID_INPUT", message: "image exceeds 8MB" } },
          400,
          corsHeaders
        );
      }

      if (typeof rawParams !== "string") {
        return json(
          { error: { code: "INVALID_INPUT", message: "params must be a JSON string" } },
          400,
          corsHeaders
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawParams);
      } catch {
        return json(
          { error: { code: "INVALID_INPUT", message: "params must be valid JSON" } },
          400,
          corsHeaders
        );
      }

      const params = validateParams(parsed);
      const prompt = buildPrompt(params);

      const openAiForm = new FormData();
      openAiForm.append("model", "gpt-image-1-mini");
      openAiForm.append("prompt", prompt);
      openAiForm.append("image", image, image.name || "input.png");
      openAiForm.append("quality", params.quality);
      openAiForm.append("size", "1024x1024");
      openAiForm.append("response_format", "b64_json");

      const started = Date.now();
      const openAiResponse = await fetch("https://api.openai.com/v1/images/edits", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: openAiForm
      });

      const openAiBody = (await openAiResponse.json()) as Record<string, unknown>;

      if (!openAiResponse.ok) {
        return json(
          {
            error: {
              code: "UPSTREAM_ERROR",
              message: extractOpenAiError(openAiBody) ?? "OpenAI request failed"
            }
          },
          openAiResponse.status,
          corsHeaders
        );
      }

      const firstImage = extractImagePayload(openAiBody);
      if (!firstImage) {
        return json(
          { error: { code: "UPSTREAM_ERROR", message: "No image output returned by model" } },
          502,
          corsHeaders
        );
      }

      const cleanedBase64 = firstImage.b64.replace(/\s+/g, "");
      const mimeType = inferMimeTypeFromBase64(cleanedBase64, firstImage.mime);

      return json(
        {
          id: (openAiBody.id as string | undefined) ?? crypto.randomUUID(),
          image_base64: cleanedBase64,
          mime_type: mimeType,
          image_data_url: `data:${mimeType};base64,${cleanedBase64}`,
          meta: {
            model: "gpt-image-1-mini",
            quality: params.quality,
            elapsed_ms: Date.now() - started
          }
        },
        200,
        corsHeaders
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      return json(
        { error: { code: "INTERNAL_ERROR", message } },
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
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  headers.set("access-control-max-age", "86400");
  return headers;
}

function buildPrompt(params: AgeParams): string {
  const ageDirection = params.age_delta >= 0 ? "older" : "younger";
  const ageYears = Math.abs(params.age_delta);

  const instructions = [
    "Edit the provided portrait photo.",
    `Make the subject appear ${ageYears} years ${ageDirection} with intensity ${params.intensity.toFixed(2)}.`,
    `Hair color: ${params.hair_color}.`,
    `Glasses: ${params.glasses}.`,
    `Baldness level: ${params.baldness}/100.`,
    `Blemish correction level: ${params.blemish_fix}/100.`,
    `Skin texture shift: ${params.skin_texture} on a scale from -100 to 100.`,
    params.preserve_identity
      ? "Preserve identity, facial geometry, expression, pose, and background as much as possible."
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
