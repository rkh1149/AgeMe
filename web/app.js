const controls = {
  form: document.getElementById("controls"),
  apiUrl: document.getElementById("apiUrl"),
  photo: document.getElementById("photo"),
  ageDelta: document.getElementById("ageDelta"),
  intensity: document.getElementById("intensity"),
  hairColor: document.getElementById("hairColor"),
  glasses: document.getElementById("glasses"),
  baldness: document.getElementById("baldness"),
  blemishFix: document.getElementById("blemishFix"),
  skinTexture: document.getElementById("skinTexture"),
  quality: document.getElementById("quality"),
  preserveIdentity: document.getElementById("preserveIdentity"),
  debugMode: document.getElementById("debugMode"),
  regenerateBtn: document.getElementById("regenerateBtn"),
  downloadBtn: document.getElementById("downloadBtn"),
  compareSlider: document.getElementById("compareSlider"),
  afterMask: document.getElementById("afterMask"),
  beforeImage: document.getElementById("beforeImage"),
  afterImage: document.getElementById("afterImage"),
  status: document.getElementById("status"),
  debugPanel: document.getElementById("debugPanel"),
  debugOutput: document.getElementById("debugOutput"),
  ageDeltaValue: document.getElementById("ageDeltaValue"),
  intensityValue: document.getElementById("intensityValue"),
  baldnessValue: document.getElementById("baldnessValue"),
  blemishFixValue: document.getElementById("blemishFixValue"),
  skinTextureValue: document.getElementById("skinTextureValue")
};

const state = {
  sourceFile: null,
  uploadFile: null,
  uploadMaskFile: null,
  beforeObjectUrl: "",
  afterDataUrl: "",
  lastDebugInfo: null
};
const MAX_UPSTREAM_IMAGE_BYTES = 4 * 1024 * 1024;

function isDebugEnabled() {
  return Boolean(controls.debugMode?.checked);
}

function setStatus(message) {
  controls.status.textContent = message;
}

function setSliderLabels() {
  controls.ageDeltaValue.textContent = controls.ageDelta.value;
  controls.intensityValue.textContent = Number(controls.intensity.value).toFixed(2);
  controls.baldnessValue.textContent = controls.baldness.value;
  controls.blemishFixValue.textContent = controls.blemishFix.value;
  controls.skinTextureValue.textContent = controls.skinTexture.value;
}

function updateCompareMask() {
  controls.afterMask.style.width = `${controls.compareSlider.value}%`;
}

function setDebugDetails(value) {
  state.lastDebugInfo = value;
  if (!controls.debugOutput) {
    return;
  }

  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  controls.debugOutput.textContent = text;
  if (controls.debugPanel) {
    controls.debugPanel.open = true;
  }
}

function clearDebugDetails() {
  state.lastDebugInfo = null;
  if (controls.debugOutput) {
    controls.debugOutput.textContent = isDebugEnabled()
      ? "Debug mode enabled. Run Generate to capture diagnostics."
      : "Debug mode is off.";
  }
}

function clearGeneratedState() {
  state.afterDataUrl = "";
  controls.afterImage.src = "";
  controls.downloadBtn.disabled = true;
  controls.regenerateBtn.disabled = true;
}

function loadImageFromObjectUrl(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Could not decode uploaded image."));
    };
    image.src = objectUrl;
  });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Failed to re-encode image for upload."));
        return;
      }
      resolve(blob);
    }, "image/png");
  });
}

async function normalizeUploadImage(file) {
  const image = await loadImageFromObjectUrl(file);
  const squareSizes = [1024, 768, 512, 256];
  let blob = null;
  let selectedSquareSize = null;

  for (const squareSize of squareSizes) {
    const scale = Math.min(1, squareSize / Math.max(image.width, image.height));
    const drawWidth = Math.max(1, Math.round(image.width * scale));
    const drawHeight = Math.max(1, Math.round(image.height * scale));
    const offsetX = Math.floor((squareSize - drawWidth) / 2);
    const offsetY = Math.floor((squareSize - drawHeight) / 2);

    const canvas = document.createElement("canvas");
    canvas.width = squareSize;
    canvas.height = squareSize;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Could not prepare image for upload.");
    }

    context.clearRect(0, 0, squareSize, squareSize);
    context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
    const candidate = await canvasToPngBlob(canvas);
    if (candidate.size <= MAX_UPSTREAM_IMAGE_BYTES) {
      blob = candidate;
      selectedSquareSize = squareSize;
      break;
    }
  }

  if (!blob || !selectedSquareSize) {
    throw new Error("Prepared PNG is larger than 4 MB. Please use a smaller image.");
  }

  const maskCanvas = document.createElement("canvas");
  maskCanvas.width = selectedSquareSize;
  maskCanvas.height = selectedSquareSize;
  const maskContext = maskCanvas.getContext("2d");
  if (!maskContext) {
    throw new Error("Could not prepare edit mask.");
  }
  maskContext.clearRect(0, 0, selectedSquareSize, selectedSquareSize);
  const maskBlob = await canvasToPngBlob(maskCanvas);

  const normalizedName = (file.name || "upload")
    .replace(/\.[a-z0-9]+$/i, "")
    .concat(".png");
  const maskName = normalizedName.replace(/\.png$/i, "-mask.png");

  return {
    imageFile: new File([blob], normalizedName, { type: "image/png" }),
    maskFile: new File([maskBlob], maskName, { type: "image/png" })
  };
}

async function onPhotoChange() {
  const file = controls.photo.files?.[0];
  clearGeneratedState();
  clearDebugDetails();

  if (!file) {
    setStatus("Select a photo to start.");
    controls.beforeImage.src = "";
    state.sourceFile = null;
    state.uploadFile = null;
    state.uploadMaskFile = null;
    return;
  }

  if (!file.type.startsWith("image/")) {
    setStatus("Please upload a valid image file.");
    controls.photo.value = "";
    return;
  }

  if (file.size > 8 * 1024 * 1024) {
    setStatus("File exceeds 8 MB. Please use a smaller image.");
    controls.photo.value = "";
    return;
  }

  state.sourceFile = file;
  if (state.beforeObjectUrl) {
    URL.revokeObjectURL(state.beforeObjectUrl);
  }

  state.beforeObjectUrl = URL.createObjectURL(file);
  controls.beforeImage.src = state.beforeObjectUrl;
  controls.afterImage.src = state.beforeObjectUrl;

  try {
    setStatus("Preparing image for generation...");
    const normalized = await normalizeUploadImage(file);
    state.uploadFile = normalized.imageFile;
    state.uploadMaskFile = normalized.maskFile;
    setStatus("Photo loaded. Adjust settings and click Generate.");
  } catch (error) {
    state.uploadFile = null;
    state.uploadMaskFile = null;
    const message = error instanceof Error ? error.message : "Image preparation failed.";
    setStatus(`Error: ${message}`);
  }
}

function buildParams() {
  return {
    age_delta: Number(controls.ageDelta.value),
    intensity: Number(controls.intensity.value),
    hair_color: controls.hairColor.value,
    glasses: controls.glasses.value,
    baldness: Number(controls.baldness.value),
    blemish_fix: Number(controls.blemishFix.value),
    skin_texture: Number(controls.skinTexture.value),
    quality: controls.quality.value,
    preserve_identity: controls.preserveIdentity.checked
  };
}

function normalizeImageDataUrl(body) {
  if (typeof body.image_data_url === "string" && body.image_data_url.startsWith("data:image/")) {
    return body.image_data_url;
  }

  let base64 = "";
  if (typeof body.image_base64 === "string") {
    base64 = body.image_base64.trim();
  }

  if (base64.startsWith("data:image/")) {
    return base64;
  }

  if (!base64) {
    throw new Error("No image data was returned by the API.");
  }

  const mime = typeof body.mime_type === "string" && body.mime_type.startsWith("image/")
    ? body.mime_type
    : "image/png";

  const normalizedBase64 = base64.replace(/\s+/g, "");
  return `data:${mime};base64,${normalizedBase64}`;
}

function setAfterImageSource(dataUrl) {
  return new Promise((resolve, reject) => {
    controls.afterImage.onload = () => resolve();
    controls.afterImage.onerror = () => reject(new Error("Generated image could not be decoded by the browser."));
    controls.afterImage.src = dataUrl;
  });
}

function parseJsonSafely(rawText) {
  if (!rawText) {
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return { raw_text: rawText };
  }
}

function buildClientDebug(params, uploadFile, uploadMaskFile) {
  return {
    timestamp: new Date().toISOString(),
    endpoint: controls.apiUrl.value.trim(),
    upload: {
      source_name: state.sourceFile?.name || null,
      source_type: state.sourceFile?.type || null,
      source_size: state.sourceFile?.size || null,
      sent_name: uploadFile?.name || null,
      sent_type: uploadFile?.type || null,
      sent_size: uploadFile?.size || null,
      mask_name: uploadMaskFile?.name || null,
      mask_type: uploadMaskFile?.type || null,
      mask_size: uploadMaskFile?.size || null
    },
    params
  };
}

async function generateImage() {
  const uploadFile = state.uploadFile || state.sourceFile;
  if (!uploadFile) {
    setStatus("Please choose a photo first.");
    return;
  }

  const apiUrl = controls.apiUrl.value.trim();
  if (!apiUrl) {
    setStatus("Set your API endpoint first.");
    return;
  }

  const params = buildParams();
  const payload = new FormData();
  payload.append("image", uploadFile, uploadFile.name);
  if (state.uploadMaskFile) {
    payload.append("mask", state.uploadMaskFile, state.uploadMaskFile.name);
  }
  payload.append("params", JSON.stringify(params));

  const debugEnabled = isDebugEnabled();
  if (debugEnabled) {
    setDebugDetails({ stage: "request", client: buildClientDebug(params, uploadFile, state.uploadMaskFile) });
  } else {
    clearDebugDetails();
  }

  setStatus("Generating image...");
  controls.form.querySelector("button[type='submit']").disabled = true;

  try {
    const headers = {};
    if (debugEnabled) {
      headers["x-ageme-debug"] = "1";
    }

    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: payload
    });

    const rawBody = await response.text();
    const body = parseJsonSafely(rawBody);

    if (!response.ok) {
      if (debugEnabled) {
        setDebugDetails({
          stage: "error-response",
          http_status: response.status,
          status_text: response.statusText,
          body
        });
      }
      throw new Error(body?.error?.message || "Generation failed.");
    }

    if (debugEnabled && body?.debug) {
      setDebugDetails({
        stage: "success-response",
        worker_debug: body.debug,
        meta: body.meta || null
      });
    }

    const dataUrl = normalizeImageDataUrl(body);
    await setAfterImageSource(dataUrl);
    state.afterDataUrl = dataUrl;

    controls.downloadBtn.disabled = false;
    controls.regenerateBtn.disabled = false;
    setStatus("Done. Use slider to compare before and after.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed.";
    if (debugEnabled) {
      setDebugDetails({
        stage: "exception",
        message,
        endpoint: apiUrl,
        hint: "If this is a fetch/CORS failure, no upstream JSON will be available.",
        prior_debug: state.lastDebugInfo
      });
    }
    setStatus(`Error: ${message}`);
  } finally {
    controls.form.querySelector("button[type='submit']").disabled = false;
  }
}

function downloadImage() {
  if (!state.afterDataUrl) {
    return;
  }

  const a = document.createElement("a");
  a.href = state.afterDataUrl;
  a.download = `ageme-${Date.now()}.png`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

controls.form.addEventListener("submit", (event) => {
  event.preventDefault();
  generateImage();
});

controls.regenerateBtn.addEventListener("click", generateImage);
controls.downloadBtn.addEventListener("click", downloadImage);
controls.photo.addEventListener("change", onPhotoChange);
controls.compareSlider.addEventListener("input", updateCompareMask);
controls.ageDelta.addEventListener("input", setSliderLabels);
controls.intensity.addEventListener("input", setSliderLabels);
controls.baldness.addEventListener("input", setSliderLabels);
controls.blemishFix.addEventListener("input", setSliderLabels);
controls.skinTexture.addEventListener("input", setSliderLabels);
controls.debugMode.addEventListener("change", clearDebugDetails);

clearDebugDetails();
setSliderLabels();
updateCompareMask();
